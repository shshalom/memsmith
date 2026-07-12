// SPDX-License-Identifier: Apache-2.0
// Reclassify observation lifecycle_state from content using the local Ollama
// model. The initial import flattened lifecycle (decisions=active, else=resolved);
// this reads each observation and infers its true state so the dashboard's
// open/active/blocked/deferred/resolved/superseded buckets reflect reality.
//
// Usage (run under bun, against the running local runtime's embedded PG):
//   bun scripts/reclassify-lifecycle.mjs            # dry-run: classify, print, DO NOT write
//   bun scripts/reclassify-lifecycle.mjs --execute  # write lifecycle_state back
//
// Env (defaults target the local embedded PG + local Ollama):
//   PG_URL         default postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres
//   OLLAMA_URL     default http://localhost:11434/v1/chat/completions
//   OLLAMA_MODEL   default qwen2.5:14b
//   CONCURRENCY    default 4
//   LIMIT          optional cap on rows processed (for testing)
import pg from 'pg';

const PG_URL = process.env.PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '4', 10);
const LIMIT = process.env.LIMIT ? Number.parseInt(process.env.LIMIT, 10) : null;
const EXECUTE = process.argv.includes('--execute');

const ALLOWED = new Set(['open', 'active', 'blocked', 'deferred', 'resolved', 'superseded']);

const SYSTEM = `You classify a software-project observation into exactly ONE lifecycle state.
States and their meaning:
- open: an item raised but not started (an open question, an untriaged idea, a TODO not begun).
- active: work currently in progress, or a decision/policy that is currently in force and relevant.
- blocked: work that cannot proceed because it is waiting on something (a dependency, an answer, an external event).
- deferred: work deliberately postponed / parked / shelved for later (explicitly "later", "postpone", "defer", "not now").
- resolved: work that is finished, fixed, shipped, verified, or a past event that is complete.
- superseded: a decision or state that has been replaced by a newer one.
Reply with ONLY the single state word, lowercase, no punctuation.`;

async function classify(content, obsType) {
  const prompt = `Observation type: ${obsType}\nContent:\n${content}\n\nLifecycle state:`;
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('ollama ' + res.status);
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content ?? '';
  const m = String(raw).toLowerCase().match(/[a-z]+/);
  const label = m ? m[0] : null;
  return label && ALLOWED.has(label) ? label : null;
}

async function classifyWithRetry(content, obsType, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const label = await classify(content, obsType);
      if (label) return label;
    } catch { /* retry */ }
  }
  return null;
}

async function main() {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  // RESUMABLE: skip rows already reclassified in a prior run (marked with
  // metadata.lifecycle_reclassified=true). This makes re-runs after a stall
  // pick up only the remaining rows instead of redoing everything.
  const sql = `SELECT id, obs_type, content, lifecycle_state
               FROM observations
               WHERE NOT COALESCE((metadata->>'lifecycle_reclassified')::boolean, false)
               ORDER BY created_at ASC${LIMIT ? ` LIMIT ${LIMIT}` : ''}`;
  const { rows } = await client.query(sql);
  console.log(`[reclassify] ${rows.length} remaining observations | model=${OLLAMA_MODEL} | concurrency=${CONCURRENCY} | ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);

  const dist = {};
  let processed = 0, changed = 0, failed = 0;

  // Simple concurrency pool.
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      const label = await classifyWithRetry(row.content || '', row.obs_type || 'change');
      const next = label ?? row.lifecycle_state; // keep existing when model can't decide
      dist[next] = (dist[next] || 0) + 1;
      if (label === null) failed++;
      if (EXECUTE) {
        // Always stamp the marker (even on keep) so a resume skips this row;
        // update lifecycle_state only when it changed.
        try {
          await client.query(
            `UPDATE observations
             SET lifecycle_state = $1,
                 metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{lifecycle_reclassified}', 'true')
             WHERE id = $2`,
            [next, row.id],
          );
        } catch (e) { /* best-effort; leave for a later resume */ }
      }
      if (next !== row.lifecycle_state) changed++;
      processed++;
      if (processed % 50 === 0) console.log(`[reclassify] ${processed}/${rows.length} (changed ${changed}, model-miss ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n[reclassify] done. processed=${processed} changed=${changed} model-miss=${failed}`);
  console.log('[reclassify] resulting lifecycle distribution:');
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
  if (!EXECUTE) console.log('\n[reclassify] DRY-RUN — no rows written. Re-run with --execute to apply.');
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
