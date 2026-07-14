/**
 * ONE-TIME dogfood seed. Mints this project's durable identity, re-scopes the
 * existing 'local'/'local' observations to it, and imports the claude-mem
 * team-agent-memory delta (dedup by observation id via ON CONFLICT DO NOTHING —
 * the same mechanism the original SQLite import used, since rows carry their
 * claude-mem id). Re-runnable: recognizes the existing marker and only inserts
 * ids not already present.
 *
 * Run:
 *   env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin \
 *     MEMSMITH_PROJECT_CWD=/Users/shwaits/Workspace/team-agent-memory \
 *     ~/.bun/bin/bun scripts/seed-dogfood-identity.ts
 *
 * Back up ~/.memsmith/pgdata BEFORE running.
 */
import { Client } from 'pg';
import { Database } from 'bun:sqlite';
import { ensureProjectIdentity, ensureBaseKey } from '../src/services/identity/project-identity.js';

const PG = 'postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const CLAUDE_MEM_DB = `${process.env.HOME}/.claude-mem/claude-mem.db`;
const CWD = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();

// claude-mem obs -> MemSmith lifecycle_state (mirrors local-runtime.ts:104).
function lifecycleFor(type: string): string {
  return type === 'decision' ? 'active' : 'resolved';
}

async function main() {
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const pool = { query: (t: string, v?: unknown[]) => pg.query(t, v as any) } as any;

  // 1. Mint / recognize identity for this project (writes .memsmith/project.json,
  //    upserts teams/projects, mints + caches base key).
  const { teamId, projectId } = await ensureProjectIdentity(pool, CWD);
  await ensureBaseKey(pool, teamId, projectId);
  console.log(`[seed] identity: team=${teamId} project=${projectId}`);

  // 2. Re-scope existing local/local rows (idempotent: only rows still on 'local').
  const before = await pg.query("SELECT count(*)::int n FROM observations WHERE team_id='local' AND project_id='local'");
  const legacyCount = before.rows[0].n as number;
  if (legacyCount > 0) {
    await pg.query(
      'UPDATE observations SET team_id=$1, project_id=$2 WHERE team_id=$3 AND project_id=$4',
      [teamId, projectId, 'local', 'local'],
    );
    console.log(`[seed] re-scoped ${legacyCount} observations local/local -> ${teamId}/${projectId}`);
  } else {
    console.log('[seed] no local/local rows to re-scope (already done)');
  }

  // 3. Import claude-mem team-agent-memory delta. Dedup by CONTENT, not id:
  //    the re-scoped MemSmith rows and the claude-mem rows use different id
  //    spaces (the original SQLite import re-generated ids), so id-based
  //    ON CONFLICT would NOT catch the ~2540-row overlap and would duplicate it.
  //    Content is the stable dedup key here. We generate a fresh uuid id for
  //    each genuinely-new row (observations.id is text NOT NULL, no default).
  const existing = await pg.query(
    'SELECT content FROM observations WHERE team_id=$1 AND project_id=$2',
    [teamId, projectId],
  );
  const seen = new Set<string>(existing.rows.map((r: { content: string }) => r.content));

  const cm = new Database(CLAUDE_MEM_DB, { readonly: true });
  const rows = cm.query(
    "SELECT type, COALESCE(NULLIF(narrative,''), NULLIF(text,''), NULLIF(title,''), '') AS content, created_at " +
    "FROM observations WHERE project='team-agent-memory'",
  ).all() as Array<{ type: string; content: string; created_at: string }>;

  let imported = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.content) { skipped++; continue; }       // skip empty
    if (seen.has(r.content)) { skipped++; continue; } // content-level dedup (overlap with re-scoped rows OR earlier claude-mem row)
    seen.add(r.content);
    await pg.query(
      `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content, created_at)
       VALUES ($1,$2,$3,'observation',$4,$5,$6, COALESCE($7::timestamptz, now()))`,
      [crypto.randomUUID(), teamId, projectId, r.type, lifecycleFor(r.type), r.content, r.created_at],
    );
    imported++;
  }
  cm.close();
  console.log(`[seed] imported ${imported} new observations from claude-mem, skipped ${skipped} (dedup/empty) of ${rows.length} candidates`);

  // 4. Verify: no local/local rows remain; report final scope count.
  const after = await pg.query("SELECT count(*)::int n FROM observations WHERE team_id='local' AND project_id='local'");
  if ((after.rows[0].n as number) !== 0) {
    throw new Error(`[seed] ABORT: ${after.rows[0].n} local/local rows still present after re-scope`);
  }
  const total = await pg.query('SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2', [teamId, projectId]);
  console.log(`[seed] DONE. dogfood scope now holds ${total.rows[0].n} observations.`);
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
