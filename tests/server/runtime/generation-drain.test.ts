// SPDX-License-Identifier: Apache-2.0
//
// THE BUG: the inline generation queue holds its work list ENTIRELY IN MEMORY
// (InlineServerQueue.waiting[]). Jobs enter it only via add(), i.e. at the moment
// they are enqueued. Nothing ever loads status='queued' rows back from Postgres.
//
// So every server restart abandons whatever was mid-queue. The rows stay in the
// database forever, each still pointing at its source agent_event, but no process
// ever picks them up again. On the dogfood this accumulated to 6,958 queued jobs
// spanning 2026-07-16 to today — two weeks of captured activity that was never
// distilled into observations, with no warning anywhere.
//
// Nothing was lost: agent_events (8,050 of them) are all intact and every job
// still carries its agent_event_id, source_type, source_id and payload. The work
// is un-run, not deleted — which is exactly why a drain can recover all of it.
//
// THE FIX: on boot, load queued rows back into the in-memory queue.
//
// Ordering matters and is load-bearing: drain OLDEST FIRST. The backlog spans two
// weeks; processing newest-first would leave the oldest gaps unfilled the longest,
// and those are the ones a user is most likely to have already noticed missing.
import { describe, it, expect } from 'bun:test';
import { loadQueuedJobsForDrain, DEFAULT_DRAIN_BATCH } from '../../../src/server/runtime/generation-drain.js';

type Row = Record<string, unknown>;

function fakePool(rows: Row[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

const JOB = (id: string, kind = 'observation') => ({
  id, job_type: kind, project_id: 'p1', team_id: 't1',
  agent_event_id: `ev-${id}`, source_type: 'agent_event', source_id: `ev-${id}`,
  server_session_id: null, payload: { some: 'payload' },
});

describe('loadQueuedJobsForDrain', () => {
  it('loads queued jobs so a restart no longer abandons them', async () => {
    const pool = fakePool([JOB('j1'), JOB('j2')]);
    const jobs = await loadQueuedJobsForDrain(pool as never);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.id).toBe('j1');
  });

  it('selects ONLY queued rows — never re-runs completed or failed work', async () => {
    // Re-running a completed job would duplicate observations; re-running a failed
    // one would loop on the same error.
    const pool = fakePool([]);
    await loadQueuedJobsForDrain(pool as never);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/status\s*=\s*'queued'/i);
    expect(sql).not.toMatch(/status\s*=\s*'completed'/i);
  });

  it('drains OLDEST FIRST', async () => {
    // The backlog spans weeks. Newest-first would starve the oldest gaps, which
    // are the ones most likely already noticed as missing.
    const pool = fakePool([]);
    await loadQueuedJobsForDrain(pool as never);
    expect(pool.calls[0]!.text).toMatch(/ORDER BY\s+created_at\s+ASC/i);
  });

  it('bounds the batch so a huge backlog cannot exhaust memory', async () => {
    // 6,958 rows loaded at once is survivable; an unbounded SELECT on a larger
    // install is not.
    const pool = fakePool([]);
    await loadQueuedJobsForDrain(pool as never);
    expect(pool.calls[0]!.text).toMatch(/LIMIT/i);
    expect(pool.calls[0]!.values).toContain(DEFAULT_DRAIN_BATCH);
  });

  it('honours an explicit batch size', async () => {
    const pool = fakePool([]);
    await loadQueuedJobsForDrain(pool as never, { batchSize: 50 });
    expect(pool.calls[0]!.values).toContain(50);
  });

  it('carries every field the processor needs to rebuild the job', async () => {
    // A job the processor cannot reconstruct is as good as lost, so the drain must
    // not drop the linkage back to the source event.
    const pool = fakePool([JOB('j1')]);
    const [job] = await loadQueuedJobsForDrain(pool as never);
    expect(job!.agentEventId).toBe('ev-j1');
    expect(job!.projectId).toBe('p1');
    expect(job!.teamId).toBe('t1');
    expect(job!.sourceType).toBe('agent_event');
    expect(job!.sourceId).toBe('ev-j1');
    expect(job!.jobType).toBe('observation');
  });

  it('returns an empty list rather than throwing when the query fails', async () => {
    // This runs at boot. A drain failure must never stop the server from starting.
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await loadQueuedJobsForDrain(boom as never)).toEqual([]);
  });

  it('skips malformed rows instead of failing the whole drain', async () => {
    // One bad row must not cost the other 6,957.
    const pool = fakePool([JOB('j1'), { id: null }, JOB('j2')]);
    const jobs = await loadQueuedJobsForDrain(pool as never);
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(['j1', 'j2']);
  });

  it('returns an empty list when there is nothing queued', async () => {
    expect(await loadQueuedJobsForDrain(fakePool([]) as never)).toEqual([]);
  });
});

import {
  requeueDrainedJobs, resolveQueueConcurrency, DEFAULT_QUEUE_CONCURRENCY,
  type DrainableJob,
} from '../../../src/server/runtime/generation-drain.js';

const DRAINABLE = (over: Partial<DrainableJob> = {}): DrainableJob => ({
  id: 'j1', jobType: 'observation', projectId: 'p1', teamId: 't1',
  agentEventId: 'ev-1', sourceType: 'agent_event', sourceId: 'ev-1',
  serverSessionId: null, payload: { kind: 'event' }, bullmqJobId: 'bull-1',
  ...over,
});

describe('requeueDrainedJobs', () => {
  function target() {
    const added: Array<{ jobId: string; payload: unknown }> = [];
    return { added, add: async (jobId: string, payload: unknown) => { added.push({ jobId, payload }); } };
  }

  it('republishes with the PERSISTED job id and payload, not a rebuilt one', async () => {
    // The payload was written at enqueue time precisely so a re-enqueue passes
    // the worker's validation. Reconstructing it would risk a shape the worker
    // rejects — replay it verbatim.
    const q = target();
    const r = await requeueDrainedJobs([DRAINABLE()], { resolveQueue: () => q });
    expect(r.requeued).toBe(1);
    expect(q.added).toEqual([{ jobId: 'bull-1', payload: { kind: 'event' } }]);
  });

  it('falls back to the row id when no queue job id was persisted', async () => {
    const q = target();
    await requeueDrainedJobs([DRAINABLE({ bullmqJobId: null })], { resolveQueue: () => q });
    expect(q.added[0]!.jobId).toBe('j1');
  });

  it('routes summary jobs to the summary lane', async () => {
    const lanes: string[] = [];
    await requeueDrainedJobs(
      [DRAINABLE({ jobType: 'summary' }), DRAINABLE({ jobType: 'observation' })],
      { resolveQueue: (k: 'event' | 'summary') => { lanes.push(k); return target(); } },
    );
    expect(lanes).toEqual(['summary', 'event']);
  });

  it('leaves jobs queued when no queue is available rather than dropping them', async () => {
    // A disabled queue adapter must not consume the backlog — the rows stay
    // queued so the next boot can retry.
    const r = await requeueDrainedJobs([DRAINABLE()], { resolveQueue: () => null });
    expect(r).toEqual({ requeued: 0, skipped: 1 });
  });

  it('skips a job with no payload instead of publishing an empty one', async () => {
    const q = target();
    const r = await requeueDrainedJobs([DRAINABLE({ payload: null })], { resolveQueue: () => q });
    expect(r.skipped).toBe(1);
    expect(q.added).toEqual([]);
  });

  it('one failing job does not cost the rest of the backlog', async () => {
    let n = 0;
    const r = await requeueDrainedJobs(
      [DRAINABLE({ id: 'a' }), DRAINABLE({ id: 'b' }), DRAINABLE({ id: 'c' })],
      {
        resolveQueue: () => ({
          add: async () => { n += 1; if (n === 2) throw new Error('queue full'); },
        }),
      },
    );
    expect(r).toEqual({ requeued: 2, skipped: 1 });
  });

  it('reports progress so the recovery is visible rather than silent', async () => {
    // The whole failure was silence: 6,958 jobs stranded with no signal.
    let seen: unknown = null;
    await requeueDrainedJobs([DRAINABLE()], {
      resolveQueue: () => target(),
      onProgress: (info: unknown) => { seen = info; },
    });
    expect(seen).toEqual({ requeued: 1, skipped: 0, total: 1 });
  });

  it('handles an empty backlog without calling the queue', async () => {
    let called = false;
    const r = await requeueDrainedJobs([], { resolveQueue: () => { called = true; return target(); } });
    expect(r).toEqual({ requeued: 0, skipped: 0 });
    expect(called).toBe(false);
  });
});

import { reclaimStaleLocks, DEFAULT_STALE_LOCK_MINUTES } from '../../../src/server/runtime/generation-drain.js';

// A job locked by a process that then died stays 'processing' forever. The drain
// cannot see it — that only looks at 'queued' — so it is stranded in a second,
// quieter way. Eleven such rows were found on the dogfood, locked since
// 2026-07-28 and never touched again.
describe('reclaimStaleLocks', () => {
  it('returns stale processing rows to queued so the drain can pick them up', async () => {
    const pool = fakePool([{ id: 'j1' }, { id: 'j2' }]);
    const n = await reclaimStaleLocks(pool as never);
    expect(n).toBe(2);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/UPDATE\s+observation_generation_jobs/i);
    expect(sql).toMatch(/SET[\s\S]*status\s*=\s*'queued'/i);
    expect(sql).toMatch(/WHERE[\s\S]*status\s*=\s*'processing'/i);
  });

  it('only reclaims locks older than the threshold — never a job in flight', async () => {
    // Reclaiming a live job would run it twice concurrently.
    const pool = fakePool([]);
    await reclaimStaleLocks(pool as never);
    expect(pool.calls[0]!.text).toMatch(/locked_at\s*<\s*now\(\)\s*-/i);
    expect(pool.calls[0]!.values).toContain(DEFAULT_STALE_LOCK_MINUTES);
  });

  it('honours an explicit staleness threshold', async () => {
    const pool = fakePool([]);
    await reclaimStaleLocks(pool as never, { staleMinutes: 5 });
    expect(pool.calls[0]!.values).toContain(5);
  });

  it('clears the lock fields so the job is cleanly re-runnable', async () => {
    const pool = fakePool([]);
    await reclaimStaleLocks(pool as never);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/locked_at\s*=\s*NULL/i);
    expect(sql).toMatch(/locked_by\s*=\s*NULL/i);
  });

  it('never throws — a reclaim failure must not stop startup', async () => {
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await reclaimStaleLocks(boom as never)).toBe(0);
  });

  it('reports zero when nothing is stale', async () => {
    expect(await reclaimStaleLocks(fakePool([]) as never)).toBe(0);
  });
});

import { reclaimTransientFailures } from '../../../src/server/runtime/generation-drain.js';

// A job whose provider was briefly unreachable exhausts its 3 attempts and lands
// in 'failed' — correctly at the time, but the cause was temporary and nothing
// ever retries it. Restarting ollama mid-drain produced exactly one:
//   {"reason": "ollama network error: fetch failed", "classification": "transient"}
describe('reclaimTransientFailures', () => {
  it('requeues transient failures so a provider blip does not lose the work', async () => {
    const pool = fakePool([{ id: 'j1' }]);
    expect(await reclaimTransientFailures(pool as never)).toBe(1);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/status\s*=\s*'queued'/i);
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'failed'/i);
  });

  it('ONLY touches transient failures — a permanent failure stays failed', async () => {
    // Retrying a job that can never succeed would burn the queue forever.
    const pool = fakePool([]);
    await reclaimTransientFailures(pool as never);
    expect(pool.calls[0]!.text).toMatch(/classification'\s*=\s*'transient'/i);
  });

  it('resets attempts so the retry has a fresh budget', async () => {
    // Requeuing with attempts already at 3/3 would re-fail immediately.
    const pool = fakePool([]);
    await reclaimTransientFailures(pool as never);
    expect(pool.calls[0]!.text).toMatch(/attempts\s*=\s*0/i);
  });

  it('clears the lock and failure timestamp for a clean re-run', async () => {
    const pool = fakePool([]);
    await reclaimTransientFailures(pool as never);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/locked_at\s*=\s*NULL/i);
    expect(sql).toMatch(/failed_at\s*=\s*NULL/i);
  });

  it('is bounded', async () => {
    const pool = fakePool([]);
    await reclaimTransientFailures(pool as never, { limit: 25 });
    expect(pool.calls[0]!.values).toContain(25);
  });

  it('never throws', async () => {
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await reclaimTransientFailures(boom as never)).toBe(0);
  });
});

describe('resolveQueueConcurrency', () => {
  it('defaults to 1 — unchanged behaviour when unconfigured', () => {
    // A local model is memory-hungry (qwen2.5:14b is ~9GB resident), so the safe
    // default stays serial. Raising it is an explicit opt-in.
    expect(resolveQueueConcurrency({})).toBe(DEFAULT_QUEUE_CONCURRENCY);
    expect(DEFAULT_QUEUE_CONCURRENCY).toBe(1);
  });

  it('honours an explicit concurrency setting', () => {
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '4' })).toBe(4);
  });

  it('clamps to a sane range', () => {
    // Each concurrent job pins another copy of the model in RAM; unbounded
    // concurrency OOMs the machine rather than going faster.
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '0' })).toBe(1);
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '-5' })).toBe(1);
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '999' })).toBe(16);
  });

  it('ignores non-numeric values rather than crashing the boot', () => {
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: 'lots' })).toBe(1);
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '' })).toBe(1);
    expect(resolveQueueConcurrency({ MEMSMITH_GENERATION_CONCURRENCY: '2.7' })).toBe(2);
  });
});
