// SPDX-License-Identifier: Apache-2.0
// Opt-in integration test: claimQueuedBacklog and failUnrunnableJobs against a throwaway Postgres.
// Run with: MEMSMITH_TEST_DRAIN=1 bun test tests/server/runtime/claim-queued-backlog-integration.test.ts
// Without opt-in: 0 tests registered.
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { rmSync, mkdirSync } from 'fs';

const OPT_IN = process.env.MEMSMITH_TEST_DRAIN === '1';
const DATA_DIR = join(tmpdir(), `ms-drain-${randomUUID()}`);
const PG_PORT = 55454;

if (OPT_IN) {
  if (DATA_DIR.includes('/.memsmith')) throw new Error('BUG: DATA_DIR points into ~/.memsmith');
  if (String(PG_PORT) === '55433') throw new Error('BUG: PG_PORT matches dogfood port');

  let manager: import('../../../src/server/runtime/EmbeddedPostgresManager.js').EmbeddedPostgresManager | null = null;

  afterAll(async () => {
    if (manager) { try { await manager.stop(); } catch { /* best-effort */ } }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('claimQueuedBacklog (opt-in integration)', () => {
    it('claims only orphaned rows, leases them, reclaims after expiry, and works in a project database', async () => {
      const { EmbeddedPostgresManager } = await import('../../../src/server/runtime/EmbeddedPostgresManager.js');
      const { ensureDatabaseExists } = await import('../../../src/server/runtime/resolve-project-database.js');
      const { bootstrapServerPostgresSchema } = await import('../../../src/storage/postgres/schema.js');
      const { claimQueuedBacklog, failUnrunnableJobs } = await import('../../../src/server/runtime/generation-drain.js');
      const pg = (await import('pg')).default;

      mkdirSync(DATA_DIR, { recursive: true });
      manager = new EmbeddedPostgresManager({
        paths: {
          binariesDir: join(homedir(), '.memsmith', 'pg-binaries'),
          dataDir: join(DATA_DIR, 'pgdata'),
          pidFile: join(DATA_DIR, 'local-pg.pid'),
        },
        port: PG_PORT,
      });
      const { connectionString } = await manager.start();
      expect(connectionString).toContain(String(PG_PORT));

      const admin = new pg.Pool({ connectionString, max: 2 });
      const dbName = 'msp_drain';
      await ensureDatabaseExists((t, p) => admin.query(t, p as unknown[]), dbName);
      const project = new pg.Pool({ connectionString: manager.buildConnectionString(dbName), max: 2 });
      try {
        await bootstrapServerPostgresSchema(project);
        const team = randomUUID();
        const proj = randomUUID();
        await project.query('INSERT INTO teams (id, name) VALUES ($1, $1)', [team]);
        await project.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $1)', [proj, team]);

        const insert = (id: string, o: { status?: string; attempts?: number; next?: string | null; age?: string }) =>
          project.query(
            `INSERT INTO observation_generation_jobs
               (id, project_id, team_id, source_type, source_id, job_type, status, idempotency_key,
                attempts, max_attempts, next_attempt_at, created_at, payload)
             VALUES ($1, $2, $3, 'observation_reindex', $1, 'observation', $4, $1, $5, 3,
                     ${o.next ?? 'NULL'}, now() - interval '${o.age ?? '10 minutes'}', '{}')`,
            [id, proj, team, o.status ?? 'queued', o.attempts ?? 0],
          );
        await insert('orphan', {});
        await insert('merged-attempt1-null', { attempts: 1 });
        await insert('processing', { status: 'processing' });
        await insert('retry-due', { attempts: 1, next: `now() - interval '1 minute'` });
        await insert('retry-backing-off', { attempts: 1, next: `now() + interval '5 minutes'` });
        await insert('young', { age: '5 seconds' });
        await insert('leased', { next: `now() + interval '5 minutes'` });
        await insert('exhausted', { attempts: 3 });

        const first = await claimQueuedBacklog(project);
        expect(first.map((j) => j.id).sort()).toEqual(['merged-attempt1-null', 'orphan']);
        expect(await claimQueuedBacklog(project)).toEqual([]);

        await project.query(`UPDATE observation_generation_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = 'orphan'`);
        expect((await claimQueuedBacklog(project)).map((j) => j.id)).toEqual(['orphan']);

        const limited = await claimQueuedBacklog(project, { batchSize: 1, minAgeSeconds: 0 });
        expect(limited.map((j) => j.id)).toEqual(['young']);

        await failUnrunnableJobs(project, ['orphan'], 'test');
        const row = await project.query(`SELECT status, last_error FROM observation_generation_jobs WHERE id = 'orphan'`);
        expect(row.rows[0].status).toBe('failed');
        expect(row.rows[0].last_error.classification).toBe('unrunnable_backlog');
        await project.query(`UPDATE observation_generation_jobs SET next_attempt_at = NULL WHERE id = 'orphan'`);
        expect((await claimQueuedBacklog(project)).map((j) => j.id)).not.toContain('orphan');
      } finally {
        await project.end();
        await admin.end();
      }
    }, 120_000);
  });
}
