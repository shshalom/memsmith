// SPDX-License-Identifier: Apache-2.0
//
// Integration proof: Go Team convert copy isolates to the requested project.
// Uses two pg.Pool instances against the same test Postgres — "local" and
// "remote" — populated with projects A and B so we can verify B's rows land
// under team 'dest' and project A never leaks to the remote side.
//
// Guard pattern mirrors tests/server/server-service.test.ts:16,62:
//   const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;
//   if (TEST_DATABASE_URL) { it('...', ...) }
// When the env var is unset, NO test is registered → clean skip, no crash.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  bootstrapServerPostgresSchema,
} from '../../../src/storage/postgres/index.js';
import {
  buildScopedReadQuery,
  buildScopedCountQuery,
  restampTeamId,
} from '../../../src/server/routes/v1/convert-scope.js';
import {
  runCopy,
  verifyCopy,
  type CopyDeps,
} from '../../../src/server/convert/copy-engine.js';

const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;

// ---------------------------------------------------------------------------
// Helper: generate unique IDs so parallel test runs don't collide
// ---------------------------------------------------------------------------
function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Guard: only register tests when a real Postgres URL is available
// ---------------------------------------------------------------------------
describe('scoped convert integration', () => {
  if (TEST_DATABASE_URL) {
    // Use distinct schemas per run for isolation
    const localSchema = `test_local_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const remoteSchema = `test_remote_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    let localPool: pg.Pool;
    let remotePool: pg.Pool;
    let deps: CopyDeps;

    // Project / team fixture IDs
    const teamLocalA = uid('tla');
    const teamLocalB = uid('tlb');
    const teamDest = uid('dest');
    const projectA = uid('projA');
    const projectB = uid('projB');

    // ---------------------------------------------------------------------------
    // Helper: run a query inside a schema-search_path override
    // ---------------------------------------------------------------------------
    async function localQuery(text: string, values?: unknown[]) {
      return localPool.query(text, values);
    }
    async function remoteQuery(text: string, values?: unknown[]) {
      return remotePool.query(text, values);
    }

    // ---------------------------------------------------------------------------
    // Setup: bootstrap both schemas and seed fixtures
    // ---------------------------------------------------------------------------
    beforeAll(async () => {
      // Each pool gets a wrapper that prefixes every query with SET search_path.
      // We achieve isolation via separate schemas on the same DB instance.

      const makeSchemaPool = (schema: string) => {
        const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
        // Intercept query to prepend search_path. We wrap the query method.
        const originalQuery = pool.query.bind(pool);
        (pool as any).query = async (...args: Parameters<typeof pool.query>) => {
          // Set search_path on every call — cheap for tests, ensures isolation.
          // We do this by acquiring a client and running two queries.
          const client = await pool.connect();
          try {
            await client.query(`SET search_path TO ${schema}, public`);
            // @ts-ignore — pass-through variadic overloads
            return await client.query(...args);
          } finally {
            client.release();
          }
        };
        (pool as any)._originalQuery = originalQuery;
        return pool;
      };

      // Create schemas first using a raw pool (no schema wrapping needed for DDL)
      const setupPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
      try {
        await setupPool.query(`CREATE SCHEMA IF NOT EXISTS ${localSchema}`);
        await setupPool.query(`CREATE SCHEMA IF NOT EXISTS ${remoteSchema}`);
      } finally {
        await setupPool.end();
      }

      localPool = makeSchemaPool(localSchema);
      remotePool = makeSchemaPool(remoteSchema);

      // Bootstrap both schemas (creates all tables, pgvector, migrations)
      await bootstrapServerPostgresSchema(localPool);
      await bootstrapServerPostgresSchema(remotePool);

      // ------------------------------------------------------------------
      // Seed LOCAL: two teams + projects A and B
      // ------------------------------------------------------------------

      // Teams
      await localQuery(
        `INSERT INTO teams (id, name) VALUES ($1, 'Team A'), ($2, 'Team B')`,
        [teamLocalA, teamLocalB],
      );

      // Project A (team A)
      await localQuery(
        `INSERT INTO projects (id, team_id, name) VALUES ($1, $2, 'Project A')`,
        [projectA, teamLocalA],
      );
      // Project B (team B)
      await localQuery(
        `INSERT INTO projects (id, team_id, name) VALUES ($1, $2, 'Project B')`,
        [projectB, teamLocalB],
      );

      // Server sessions
      const sessionA = uid('ssA');
      const sessionB = uid('ssB');
      await localQuery(
        `INSERT INTO server_sessions (id, project_id, team_id) VALUES ($1, $2, $3)`,
        [sessionA, projectA, teamLocalA],
      );
      await localQuery(
        `INSERT INTO server_sessions (id, project_id, team_id) VALUES ($1, $2, $3)`,
        [sessionB, projectB, teamLocalB],
      );

      // Agent events (A and B each get one)
      const eventA = uid('evA');
      const eventB = uid('evB');
      const idemA = uid('idemA');
      const idemB = uid('idemB');
      await localQuery(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key,
            event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, 'api', $5, 'observation.created', '{}', now())`,
        [eventA, projectA, teamLocalA, sessionA, idemA],
      );
      await localQuery(
        `INSERT INTO agent_events
           (id, project_id, team_id, server_session_id, source_adapter, idempotency_key,
            event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, 'api', $5, 'observation.created', '{}', now())`,
        [eventB, projectB, teamLocalB, sessionB, idemB],
      );

      // Observation generation jobs (A and B each get one)
      const jobA = uid('jobA');
      const jobB = uid('jobB');
      // source_type='agent_event' requires agent_event_id IS NOT NULL and source_id = agent_event_id
      await localQuery(
        `INSERT INTO observation_generation_jobs
           (id, project_id, team_id, agent_event_id, source_type, source_id,
            server_session_id, job_type, status, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, 'agent_event', $4, $5, 'generate_observations',
                 'completed', $6, '{}')`,
        [jobA, projectA, teamLocalA, eventA, sessionA, uid('ikA')],
      );
      await localQuery(
        `INSERT INTO observation_generation_jobs
           (id, project_id, team_id, agent_event_id, source_type, source_id,
            server_session_id, job_type, status, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, 'agent_event', $4, $5, 'generate_observations',
                 'completed', $6, '{}')`,
        [jobB, projectB, teamLocalB, eventB, sessionB, uid('ikB')],
      );

      // Observations: 2 for A, 2 for B
      const obsA1 = uid('oA1');
      const obsA2 = uid('oA2');
      const obsB1 = uid('oB1');
      const obsB2 = uid('oB2');
      await localQuery(
        `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_by_job_id)
         VALUES
           ($1, $2, $3, 'observation', 'A obs 1', '{}', $4),
           ($5, $2, $3, 'observation', 'A obs 2', '{}', $4)`,
        [obsA1, projectA, teamLocalA, jobA, obsA2],
      );
      await localQuery(
        `INSERT INTO observations (id, project_id, team_id, kind, content, metadata, created_by_job_id)
         VALUES
           ($1, $2, $3, 'observation', 'B obs 1', '{}', $4),
           ($5, $2, $3, 'observation', 'B obs 2', '{}', $4)`,
        [obsB1, projectB, teamLocalB, jobB, obsB2],
      );

      // Lineage for B: observation_sources (2 rows — one per obs)
      const srcB1 = uid('srcB1');
      const srcB2 = uid('srcB2');
      // source_type='agent_event' requires agent_event_id IS NOT NULL and source_id = agent_event_id
      await localQuery(
        `INSERT INTO observation_sources
           (id, observation_id, agent_event_id, generation_job_id, source_type, source_id)
         VALUES
           ($1, $2, $3, $4, 'agent_event', $3),
           ($5, $6, $3, $4, 'agent_event', $3)`,
        [srcB1, obsB1, eventB, jobB, srcB2, obsB2],
      );

      // Lineage for B: observation_generation_job_events (1 row)
      const jobEvB1 = uid('jevB1');
      await localQuery(
        `INSERT INTO observation_generation_job_events
           (id, generation_job_id, event_type, status_after, attempt, details)
         VALUES ($1, $2, 'completed', 'completed', 1, '{}')`,
        [jobEvB1, jobB],
      );

      // ------------------------------------------------------------------
      // Seed REMOTE (destination): team 'dest' + 1 team_member + 1 api_key
      // (proves D2: team-account tables are skipped / not overwritten)
      // ------------------------------------------------------------------
      const destMemberId = uid('dm');
      const destKeyId = uid('dk');
      await remoteQuery(
        `INSERT INTO teams (id, name) VALUES ($1, 'Dest Team')`,
        [teamDest],
      );
      await remoteQuery(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [teamDest, destMemberId],
      );
      await remoteQuery(
        `INSERT INTO api_keys (id, key_hash, team_id, actor_id, scopes)
         VALUES ($1, $2, $3, 'test', '["memories:write"]')`,
        [destKeyId, uid('kh'), teamDest],
      );

      // ------------------------------------------------------------------
      // Build CopyDeps — mirror buildConvertCopyDeps from
      // ServerV1PostgresRoutes.ts:1614–1640 but with scope = projectB / teamDest
      // ------------------------------------------------------------------
      const scope = { projectId: projectB, teamId: teamDest };

      deps = {
        readRows: async (table: string) => {
          const { text } = buildScopedReadQuery(table, scope.projectId);
          const result = await localQuery(text, [scope.projectId]);
          return restampTeamId(table, result.rows as Array<Record<string, unknown>>, scope.teamId);
        },
        upsertRows: async (table: string, rows: Array<Record<string, unknown>>) => {
          if (rows.length === 0) return;
          // Ensure remote schema is bootstrapped (idempotent — already done in beforeAll)
          const cols = Object.keys(rows[0]!);
          const colList = cols.map(c => `"${c}"`).join(', ');
          for (const row of rows) {
            const values = cols.map(c => row[c]);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            await remoteQuery(
              `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
              values,
            );
          }
        },
        countRows: async (which: 'local' | 'remote', table: string) => {
          const { text, params } = buildScopedCountQuery(table, which);
          const queryFn = which === 'local' ? localQuery : remoteQuery;
          const result = await queryFn(text, params(scope));
          return Number((result.rows[0] as { count: string }).count);
        },
      };
    });

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    afterAll(async () => {
      await localPool?.end();
      await remotePool?.end();
      // Drop isolated schemas
      const cleanupPool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${localSchema} CASCADE`);
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${remoteSchema} CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    });

    // ------------------------------------------------------------------
    // Core test: two-project isolation
    // ------------------------------------------------------------------
    it('copies only project B rows to the remote, leaves team-account tables untouched, and verifies cleanly', async () => {
      // First copy run
      await runCopy(deps, 'owner-x');

      // B's 2 observations landed under team_id='dest' with project_id unchanged
      const obsB = await remoteQuery(
        `SELECT * FROM observations WHERE project_id = $1`,
        [projectB],
      );
      expect(obsB.rows).toHaveLength(2);
      expect(obsB.rows.every((r: any) => r.team_id === teamDest)).toBe(true);
      expect(obsB.rows.every((r: any) => r.project_id === projectB)).toBe(true);

      // Project A NEVER leaked to the remote
      const obsA = await remoteQuery(
        `SELECT count(*) FROM observations WHERE project_id = $1`,
        [projectA],
      );
      expect(Number((obsA.rows[0] as any).count)).toBe(0);

      const projA = await remoteQuery(
        `SELECT count(*) FROM projects WHERE id = $1`,
        [projectA],
      );
      expect(Number((projA.rows[0] as any).count)).toBe(0);

      // B's lineage followed its parents (observation_sources > 0)
      const srcB = await remoteQuery(
        `SELECT count(*) FROM observation_sources
         WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $1)`,
        [projectB],
      );
      expect(Number((srcB.rows[0] as any).count)).toBeGreaterThan(0);

      // job events followed too
      const jevB = await remoteQuery(
        `SELECT count(*) FROM observation_generation_job_events
         WHERE generation_job_id IN (
           SELECT id FROM observation_generation_jobs WHERE project_id = $1
         )`,
        [projectB],
      );
      expect(Number((jevB.rows[0] as any).count)).toBeGreaterThan(0);

      // Pre-seeded destination team_members + api_keys are UNCHANGED (count still 1 each)
      const memberCount = await remoteQuery(`SELECT count(*) FROM team_members`);
      expect(Number((memberCount.rows[0] as any).count)).toBe(1);

      const keyCount = await remoteQuery(`SELECT count(*) FROM api_keys`);
      expect(Number((keyCount.rows[0] as any).count)).toBe(1);

      // verifyCopy passes despite project A present locally and unrelated dest rows
      const verification = await verifyCopy(deps);
      expect(verification.ok).toBe(true);

      // ------------------------------------------------------------------
      // Idempotency: second run must NOT double B's observations
      // ------------------------------------------------------------------
      await runCopy(deps, 'owner-x');

      const obsBAfterSecondRun = await remoteQuery(
        `SELECT count(*) FROM observations WHERE project_id = $1`,
        [projectB],
      );
      expect(Number((obsBAfterSecondRun.rows[0] as any).count)).toBe(2);
    });
  }
});
