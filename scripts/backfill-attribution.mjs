// scripts/backfill-attribution.mjs
// SPDX-License-Identifier: Apache-2.0
// Bind null-owner observations (metadata.createdByUserId IS NULL) to a target
// owner userId. One-time, idempotent, REUSABLE across projects.
//
// PRECONDITION (operator's judgment — NOT checked by this script): binding all
// null-owner rows to a single owner is correct ONLY when that owner is the sole
// author of the scoped history. True for the dogfood project now; confirm true
// for any other project before running it there.
//
// Usage (run under bun, against the target runtime's PG):
//   bun scripts/backfill-attribution.mjs            # DRY-RUN: count + sample, NO write
//   bun scripts/backfill-attribution.mjs --execute  # bind null-owner rows to OWNER_USER_ID
//
// Env:
//   OWNER_USER_ID  (required)  userId to bind null-owner rows to
//   TEAM_ID        (required)  scope to one team
//   PROJECT_ID     (optional)  further scope to one project; omit = whole team
//   PG_URL         default postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres
import pg from 'pg';

export function parseConfig(env, argv) {
  const OWNER_USER_ID = env.OWNER_USER_ID;
  const TEAM_ID = env.TEAM_ID;
  if (!OWNER_USER_ID) throw new Error('OWNER_USER_ID is required');
  if (!TEAM_ID) throw new Error('TEAM_ID is required');
  return {
    ownerUserId: OWNER_USER_ID,
    teamId: TEAM_ID,
    projectId: env.PROJECT_ID || null,
    pgUrl: env.PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    execute: argv.includes('--execute'),
  };
}

// $1 team_id [, $2 project_id]
export function buildCountSql(hasProject) {
  return hasProject
    ? `SELECT kind, count(*)::int AS n FROM observations
         WHERE team_id = $1 AND project_id = $2 AND metadata->>'createdByUserId' IS NULL
         GROUP BY kind`
    : `SELECT kind, count(*)::int AS n FROM observations
         WHERE team_id = $1 AND metadata->>'createdByUserId' IS NULL
         GROUP BY kind`;
}

// $1 owner_user_id, $2 team_id [, $3 project_id]
export function buildUpdateSql(hasProject) {
  return hasProject
    ? `UPDATE observations
          SET metadata = jsonb_set(metadata, '{createdByUserId}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE team_id = $2 AND project_id = $3 AND metadata->>'createdByUserId' IS NULL`
    : `UPDATE observations
          SET metadata = jsonb_set(metadata, '{createdByUserId}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE team_id = $2 AND metadata->>'createdByUserId' IS NULL`;
}

async function main() {
  const cfg = parseConfig(process.env, process.argv.slice(2));
  const hasProject = cfg.projectId != null;
  const client = new pg.Client({ connectionString: cfg.pgUrl });
  await client.connect();
  try {
    const countParams = hasProject ? [cfg.teamId, cfg.projectId] : [cfg.teamId];
    const before = await client.query(buildCountSql(hasProject), countParams);
    const total = before.rows.reduce((s, r) => s + r.n, 0);
    console.log(`[backfill] scope team=${cfg.teamId}${hasProject ? ` project=${cfg.projectId}` : ''}`);
    console.log(`[backfill] null-owner rows: ${total}`, JSON.stringify(before.rows));

    // Sample up to 5 for eyeballing.
    const sample = await client.query(
      hasProject
        ? `SELECT id, kind, left(content, 80) AS preview FROM observations
             WHERE team_id = $1 AND project_id = $2 AND metadata->>'createdByUserId' IS NULL LIMIT 5`
        : `SELECT id, kind, left(content, 80) AS preview FROM observations
             WHERE team_id = $1 AND metadata->>'createdByUserId' IS NULL LIMIT 5`,
      countParams,
    );
    for (const r of sample.rows) console.log(`  - ${r.id} [${r.kind}] ${r.preview}`);

    if (!cfg.execute) {
      console.log('[backfill] DRY-RUN — no rows written. Re-run with --execute to apply.');
      return;
    }
    const updateParams = hasProject ? [cfg.ownerUserId, cfg.teamId, cfg.projectId] : [cfg.ownerUserId, cfg.teamId];
    await client.query('BEGIN');
    try {
      const res = await client.query(buildUpdateSql(hasProject), updateParams);
      const after = await client.query(buildCountSql(hasProject), countParams);
      await client.query('COMMIT');
      const remaining = after.rows.reduce((s, r) => s + r.n, 0);
      console.log(`[backfill] bound ${res.rowCount} rows to owner=${cfg.ownerUserId}; null-owner remaining: ${remaining}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    await client.end();
  }
}

// Only run main() when invoked directly (not when imported by the test).
if (import.meta.main) {
  main().catch((e) => { console.error('[backfill] ERROR', e.message); process.exit(1); });
}
