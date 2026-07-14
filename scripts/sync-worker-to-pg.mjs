// SPDX-License-Identifier: Apache-2.0
// One-shot reconcile: copy recent worker/SQLite observations into the embedded
// Postgres store the dashboard reads, so today's live captures become visible.
// Idempotent (ON CONFLICT DO NOTHING, id = 'wsync-<workerId>'). Embeds each row.
//
//   bun scripts/sync-worker-to-pg.mjs            # dry-run (count only)
//   bun scripts/sync-worker-to-pg.mjs --execute  # insert + embed
//
// Env: SINCE (ISO, default '2026-07-11T23:00' = post-import work),
//      PG_URL, SQLITE (default ~/.memsmith/memsmith.db).
import pg from 'pg';
import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { join } from 'path';

const PG_URL = process.env.PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const SQLITE = process.env.SQLITE || join(homedir(), '.memsmith', 'memsmith.db');
const SINCE = process.env.SINCE || '2026-07-11T23:00';
const EXECUTE = process.argv.includes('--execute');
const TEAM = process.env.MEMSMITH_LOCAL_DEV_TEAM_ID || 'local';
const PROJECT = process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID || 'local';

const CANON = new Set(['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'security_alert', 'security_note']);

function pickContent(r) {
  const parts = [];
  if (r.title) parts.push(String(r.title));
  if (r.subtitle) parts.push(String(r.subtitle));
  if (r.narrative) parts.push(String(r.narrative));
  if (!parts.length && r.text) parts.push(String(r.text));
  if (!parts.length && r.facts) {
    try { const f = JSON.parse(r.facts); if (Array.isArray(f)) parts.push(f.join('\n')); } catch { /* ignore */ }
  }
  return parts.join('\n\n').trim();
}

async function main() {
  const db = new Database(SQLITE, { readonly: true });
  const rows = db.prepare(
    `SELECT id, type, title, subtitle, narrative, text, facts, created_at
     FROM observations WHERE created_at >= ? ORDER BY created_at ASC`,
  ).all(SINCE);
  const mapped = rows
    .map(r => ({
      id: 'wsync-' + r.id,
      obsType: CANON.has(String(r.type)) ? String(r.type) : 'change',
      lifecycle: String(r.type) === 'decision' ? 'active' : 'resolved',
      content: pickContent(r),
      createdAt: r.created_at,
    }))
    .filter(r => r.content.length > 0);
  console.log(`[sync] ${rows.length} worker rows since ${SINCE}; ${mapped.length} with content | ${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
  if (!EXECUTE) { console.log('[sync] dry-run — re-run with --execute'); return; }

  const c = new pg.Client({ connectionString: PG_URL });
  await c.connect();
  await c.query('INSERT INTO teams (id,name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [TEAM]);
  await c.query('INSERT INTO projects (id,team_id,name) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING', [PROJECT, TEAM]);

  let inserted = 0;
  for (const r of mapped) {
    const res = await c.query(
      `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content, created_at)
       VALUES ($1,$2,$3,'observation',$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [r.id, TEAM, PROJECT, r.obsType, r.lifecycle, r.content, r.createdAt],
    );
    inserted += res.rowCount ?? 0;
  }
  console.log(`[sync] inserted ${inserted} new rows`);

  // Embed the freshly-inserted rows so semantic search + dashboard include them.
  const { embed } = await import('../src/server/generation/embedder.js');
  const pending = await c.query(`SELECT id, content FROM observations WHERE id LIKE 'wsync-%' AND embedding_vec IS NULL`);
  let embedded = 0;
  for (const row of pending.rows) {
    try {
      const vec = await embed(row.content || ' ');
      await c.query('UPDATE observations SET embedding_vec = $1::public.vector WHERE id = $2', ['[' + vec.join(',') + ']', row.id]);
      embedded++;
    } catch (e) { /* best-effort */ }
  }
  console.log(`[sync] embedded ${embedded} rows`);
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
