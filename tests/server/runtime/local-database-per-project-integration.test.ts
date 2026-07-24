// SPDX-License-Identifier: Apache-2.0
// Opt-in integration test: proves per-project DB physical isolation.
// Run with: MEMSMITH_TEST_DBPERPROJ=1 bun test tests/server/runtime/local-database-per-project-integration.test.ts
// Without opt-in: 0 tests registered — clean skip, no PG, no crash.
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { rmSync, mkdirSync } from 'fs';

const OPT_IN = process.env.MEMSMITH_TEST_DBPERPROJ === '1';
const DATA_DIR = join(tmpdir(), `ms-dbperproj-${randomUUID()}`);
const PG_PORT = 55451; // non-dogfood; dogfood is 55433, coldboot is 55450

if (OPT_IN) {
  // HARD dogfood guard — must be verified before any PG interaction
  if (DATA_DIR.includes('/.memsmith')) throw new Error('BUG: DATA_DIR points into ~/.memsmith');
  if (String(PG_PORT) === '55433') throw new Error('BUG: PG_PORT matches dogfood port');

  let manager: import('../../../src/server/runtime/EmbeddedPostgresManager.js').EmbeddedPostgresManager | null = null;

  afterAll(async () => {
    if (manager) {
      try { await manager.stop(); } catch { /* best-effort */ }
    }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('per-project database isolation (opt-in integration)', () => {
    it('boots throwaway PG, creates two isolated DBs, proves physical row isolation, idempotent ensure', async () => {
      // Hard guard inside the test as well
      expect(DATA_DIR.includes('/.memsmith')).toBe(false);
      expect(String(PG_PORT)).not.toBe('55433');

      const { EmbeddedPostgresManager } = await import('../../../src/server/runtime/EmbeddedPostgresManager.js');
      const { ensureDatabaseExists } = await import('../../../src/server/runtime/resolve-project-database.js');
      const { bootstrapServerPostgresSchema } = await import('../../../src/storage/postgres/schema.js');
      const pg = (await import('pg')).default;

      const throwawayDataDir = join(DATA_DIR, 'pgdata');
      const throwawayPidFile = join(DATA_DIR, 'local-pg.pid');
      const existingBinariesDir = join(homedir(), '.memsmith', 'pg-binaries');

      mkdirSync(DATA_DIR, { recursive: true });

      manager = new EmbeddedPostgresManager({
        paths: {
          binariesDir: existingBinariesDir,
          dataDir: throwawayDataDir,
          pidFile: throwawayPidFile,
        },
        port: PG_PORT,
      });

      const { connectionString } = await manager.start();
      expect(connectionString).toContain(String(PG_PORT));

      // Admin pool on the base 'postgres' DB
      const adminPool = new pg.Pool({ connectionString, max: 3 });
      try {
        // Step 1: create two project DBs
        const dbA = 'msp_A';
        const dbB = 'msp_B';
        await ensureDatabaseExists((t, p) => adminPool.query(t, p as unknown[]), dbA);
        await ensureDatabaseExists((t, p) => adminPool.query(t, p as unknown[]), dbB);

        // Step 2: bootstrap schema in each DB and insert FK-satisfying rows
        const connA = manager.buildConnectionString(dbA);
        const connB = manager.buildConnectionString(dbB);

        const poolA = new pg.Pool({ connectionString: connA, max: 2 });
        const poolB = new pg.Pool({ connectionString: connB, max: 2 });

        try {
          await bootstrapServerPostgresSchema(poolA);
          await bootstrapServerPostgresSchema(poolB);

          const teamA = randomUUID();
          const projectA = randomUUID();
          const teamB = randomUUID();
          const projectB = randomUUID();

          // Insert FK rows (teams + projects) in each DB
          await poolA.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [teamA]);
          await poolA.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING', [projectA, teamA]);

          await poolB.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [teamB]);
          await poolB.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING', [projectB, teamB]);

          // Insert one observation into each DB
          const obsIdA = randomUUID();
          const obsIdB = randomUUID();

          await poolA.query(
            `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content)
             VALUES ($1, $2, $3, 'observation', 'discovery', 'resolved', $4)`,
            [obsIdA, teamA, projectA, 'Observation in project A'],
          );

          await poolB.query(
            `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content)
             VALUES ($1, $2, $3, 'observation', 'discovery', 'resolved', $4)`,
            [obsIdB, teamB, projectB, 'Observation in project B'],
          );

          // Step 3: isolation assertions
          // msp_A sees exactly 1 row — A's row
          const aRows = await poolA.query('SELECT id FROM observations');
          expect(aRows.rows).toHaveLength(1);
          expect((aRows.rows[0] as { id: string }).id).toBe(obsIdA);
          // B's id is ABSENT from A
          const aHasB = await poolA.query('SELECT 1 FROM observations WHERE id = $1', [obsIdB]);
          expect(aHasB.rows).toHaveLength(0);

          // msp_B sees exactly 1 row — B's row
          const bRows = await poolB.query('SELECT id FROM observations');
          expect(bRows.rows).toHaveLength(1);
          expect((bRows.rows[0] as { id: string }).id).toBe(obsIdB);
          // A's id is ABSENT from B
          const bHasA = await poolB.query('SELECT 1 FROM observations WHERE id = $1', [obsIdA]);
          expect(bHasA.rows).toHaveLength(0);

          // Step 4: idempotent re-ensure
          // Should not throw, should not create duplicate DB
          await ensureDatabaseExists((t, p) => adminPool.query(t, p as unknown[]), dbA);
          const dbCountAfter = await adminPool.query('SELECT count(*) AS n FROM pg_database WHERE datname = $1', [dbA]);
          expect(Number((dbCountAfter.rows[0] as { n: string }).n)).toBe(1);
        } finally {
          await poolA.end();
          await poolB.end();
        }

        // Cleanup: drop the throwaway DBs before stopping PG
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbA}"`);
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbB}"`);
      } finally {
        await adminPool.end();
      }
    }, 60_000);
  });
}
