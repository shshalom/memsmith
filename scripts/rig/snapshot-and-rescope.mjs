// scripts/rig/snapshot-and-rescope.mjs
// SPDX-License-Identifier: Apache-2.0
// Read-only snapshot of dogfood observations + re-scoped import into a target
// store under a FRESH (temp) identity, so copied content carries a throwaway
// identity — never the dogfood's. Dogfood is opened READ-ONLY (pg_dump / SELECT).
// The pure rescope* transforms are unit-tested; the live dump/import is in main().
import pg from 'pg';
import { assertRigSafe } from './preflight.mjs';

export function rescopeRow(row, target) {
  return { ...row, team_id: target.teamId, project_id: target.projectId };
}
export function rescopeRows(rows, target) {
  return rows.map((r) => rescopeRow(r, target));
}

async function main() {
  // Env: SOURCE_PG_URL (dogfood, read-only), TARGET_PG_URL, TARGET_TEAM_ID, TARGET_PROJECT_ID,
  //      TARGET_DATA_DIR (for the preflight assertion on the target).
  const sourceUrl = process.env.SOURCE_PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
  const targetUrl = process.env.TARGET_PG_URL;
  const target = { teamId: process.env.TARGET_TEAM_ID, projectId: process.env.TARGET_PROJECT_ID };
  if (!targetUrl || !target.teamId || !target.projectId) {
    console.error('[snapshot] TARGET_PG_URL, TARGET_TEAM_ID, TARGET_PROJECT_ID are required');
    process.exit(1);
  }
  // Guard: the TARGET must not be the dogfood; the SOURCE is expected to BE the dogfood (read-only), so we only guard the target.
  assertRigSafe({ dataDir: process.env.TARGET_DATA_DIR, dbUrl: targetUrl, httpPort: undefined });
  if (target.teamId === 'ab8e1f17-020e-4794-bae3-e59885e7df05' || target.projectId === '5fc024f0-0994-4f1d-baed-300d9b4d3416') {
    console.error('[snapshot] refusing: target identity equals the dogfood identity');
    process.exit(1);
  }

  const src = new pg.Client({ connectionString: sourceUrl });
  const dst = new pg.Client({ connectionString: targetUrl });
  await src.connect(); await dst.connect();
  try {
    // READ-ONLY select from dogfood.
    const rows = (await src.query(
      `SELECT id, team_id, project_id, kind, content, metadata, obs_type, lifecycle_state FROM observations`,
    )).rows;
    const rescoped = rescopeRows(rows, target);
    let inserted = 0;
    await dst.query('BEGIN');
    try {
      // Idempotently ensure the target team and project rows exist so FK constraints
      // on observations(team_id) and observations(project_id, team_id) are satisfied.
      await dst.query(
        `INSERT INTO teams (id, name) VALUES ($1, 'rig-temp') ON CONFLICT (id) DO NOTHING`,
        [target.teamId],
      );
      await dst.query(
        `INSERT INTO projects (id, team_id, name) VALUES ($1, $2, 'rig-temp') ON CONFLICT (id) DO NOTHING`,
        [target.projectId, target.teamId],
      );
      for (const r of rescoped) {
        // metadata is copied verbatim and may carry the source author's createdByUserId; this is fine because the attribution proof (P2) mints its own identities.
        const res = await dst.query(
          `INSERT INTO observations (id, team_id, project_id, kind, content, metadata, obs_type, lifecycle_state)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,COALESCE($8,'open'))
             ON CONFLICT (id) DO NOTHING`,
          [r.id, r.team_id, r.project_id, r.kind, r.content, JSON.stringify(r.metadata ?? {}), r.obs_type ?? null, r.lifecycle_state ?? null],
        );
        inserted += res.rowCount ?? 0;
      }
      await dst.query('COMMIT');
    } catch (e) { await dst.query('ROLLBACK'); throw e; }
    // Differentiation assertion: every imported row carries the TARGET identity.
    const bad = (await dst.query(
      `SELECT count(*)::int AS n FROM observations WHERE team_id = $1 OR project_id = $2`,
      ['ab8e1f17-020e-4794-bae3-e59885e7df05', '5fc024f0-0994-4f1d-baed-300d9b4d3416'],
    )).rows[0].n;
    console.log(`[snapshot] imported ${inserted} rows re-scoped to team=${target.teamId} project=${target.projectId}; dogfood-identity rows in target: ${bad}`);
    if (bad > 0) { console.error('[snapshot] FAIL: target holds dogfood-identity rows'); process.exit(1); }
  } finally { await src.end(); await dst.end(); }
}

if (import.meta.main) {
  main().catch((e) => { console.error('[snapshot] ERROR', e.message); process.exit(1); });
}
