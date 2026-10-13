import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { claimDueRetries } from '../../../src/server/runtime/generation-drain.js';

// Fresh-install rehearsal (2026-10-07): Ollama dropped a connection, the job
// was marked for retry (`queued`, attempts=1, next_attempt_at set), and nothing
// ever picked it up again because the inline queue has no retry timer.

const url = process.env.MEMSMITH_TEST_POSTGRES_URL;
const schema = `claim_retries_${process.pid}`;

describe.skipIf(!url)('claimDueRetries (real Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE observation_generation_jobs (
      id TEXT PRIMARY KEY, job_type TEXT, project_id TEXT NOT NULL, team_id TEXT NOT NULL,
      agent_event_id TEXT, source_type TEXT, source_id TEXT, server_session_id TEXT,
      payload JSONB, bullmq_job_id TEXT, status TEXT NOT NULL, attempts INT NOT NULL,
      max_attempts INT NOT NULL, next_attempt_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)`);
    const insert = (id: string, status: string, attempts: number, nextAttempt: string | null) =>
      pool.query(
        `INSERT INTO observation_generation_jobs
           (id, project_id, team_id, status, attempts, max_attempts, next_attempt_at, payload)
         VALUES ($1, 'p', 't', $2, $3, 3, ${nextAttempt === null ? 'NULL' : nextAttempt}, '{}')`,
        [id, status, attempts],
      );
    await insert('due-retry', 'queued', 1, `now() - interval '1 minute'`);
    await insert('backing-off', 'queued', 1, `now() + interval '5 minutes'`);
    await insert('first-attempt', 'queued', 0, null);
    await insert('exhausted', 'queued', 3, `now() - interval '1 minute'`);
    await insert('running', 'processing', 1, null);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  it('claims only retries whose backoff has elapsed', async () => {
    const claimed = await claimDueRetries(pool);
    expect(claimed.map((j) => j.id)).toEqual(['due-retry']);
  });

  it('does not hand out the same retry twice while its lease holds', async () => {
    expect(await claimDueRetries(pool)).toEqual([]);
    const row = await pool.query(`SELECT next_attempt_at > now() AS leased FROM observation_generation_jobs WHERE id = 'due-retry'`);
    expect(row.rows[0].leased).toBe(true);
  });
});
