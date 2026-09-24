// SPDX-License-Identifier: Apache-2.0
//
// The drain must not requeue a job that can never run.
//
// loadQueuedJobsForDrain selected `WHERE status = 'queued'` with no check on
// attempts. A job that has burned all its attempts stays `queued` — the worker
// refuses it — so the drain finds it again on the next poll, forever.
//
// Measured live on the dogfood install: 12 jobs from JULY 16 stuck at
// attempts=3/3, requeued 156,858 times in four hours and still climbing
// (`generation backlog drain {found=14, requeued=14, totalRequeued=156858}`).
// That loop saturates the generation lane, so nothing else gets distilled —
// a brand-new project's events sat unprocessed behind five-week-old corpses.
//
// The failure mode is the one this codebase keeps producing: every component
// reports success. The drain "requeued 14", the jobs are "queued", the queue is
// "active" — and no memory is being made. Silence would have been better; this
// was noise that looked like progress.
//
// The source events are NOT lost — they remain in agent_events, so a job that
// is retired here can still be regenerated deliberately. What must stop is the
// spin.

import { describe, it, expect } from 'bun:test';
import { loadQueuedJobsForDrain } from '../../../src/server/runtime/generation-drain.js';

/** Captures the SQL the drain issues so the WHERE clause can be asserted. */
function spyPool(rows: unknown[] = []) {
  const queries: string[] = [];
  return {
    queries,
    query: async (text: string) => { queries.push(text); return { rows, rowCount: rows.length }; },
  };
}

describe('loadQueuedJobsForDrain', () => {
  it('excludes jobs that have reached max_attempts', async () => {
    // THE FIX. Without this predicate an exhausted job is selected on every
    // poll, requeued, refused, and selected again — 156,858 times in four hours
    // on a real install.
    const pool = spyPool();
    await loadQueuedJobsForDrain(pool as never, { batchSize: 10 });
    const sql = pool.queries[0] ?? '';
    expect(sql).toMatch(/attempts\s*<\s*max_attempts/);
  });

  it('still selects only queued jobs', async () => {
    // The existing behaviour must survive: completed/failed/processing rows are
    // not the drain's business.
    const pool = spyPool();
    await loadQueuedJobsForDrain(pool as never, { batchSize: 10 });
    expect(pool.queries[0]).toMatch(/status\s*=\s*'queued'/);
  });

  it('still returns eligible jobs', async () => {
    // The guard must not become "select nothing" — that would silently stop
    // recovery, which is the bug the drain exists to fix.
    const pool = spyPool([{
      id: 'j1', job_type: 'observation_generate_for_event', project_id: 'p', team_id: 't',
      agent_event_id: 'e1', source_type: 'agent_event', source_id: 's1',
      server_session_id: null, payload: {}, bullmq_job_id: null,
    }]);
    const jobs = await loadQueuedJobsForDrain(pool as never, { batchSize: 10 });
    expect(jobs.length).toBe(1);
  });

  it('returns [] rather than throwing when the query fails', async () => {
    // Runs on the boot path; a database blip must not break startup.
    const pool = { query: async () => { throw new Error('db down'); } };
    expect(await loadQueuedJobsForDrain(pool as never)).toEqual([]);
  });
});
