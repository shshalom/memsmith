import { describe, it, expect } from 'bun:test';
import { InlineServerQueue } from '../../../src/server/runtime/InlineServerQueue.js';
import { requeueOrphanedJobs, requeueDrainedJobs, claimQueuedBacklog, screenJobs, loadQueuedJobsForDrain } from '../../../src/server/runtime/generation-drain.js';
import { runRetrySweep } from '../../../src/server/runtime/retry-sweep.js';
import { runContinuousDrain } from '../../../src/server/runtime/continuous-drain.js';

interface Row { id: string; leased: boolean }

/** Models the claim query: oldest-first, at most LIMIT unleased rows, leasing what it returns. */
function fakeProjectPool(rows: Row[]) {
  return {
    rows,
    query: async (text: string, values: unknown[] = []) => {
      if (!/UPDATE observation_generation_jobs/.test(text)) return { rows: [] };
      const claimed = rows.filter((r) => !r.leased).slice(0, values[0] as number);
      for (const r of claimed) r.leased = true;
      return {
        rows: claimed.map((r) => ({
          id: r.id, project_id: 'p', team_id: 't', payload: { id: r.id }, bullmq_job_id: r.id,
        })),
      };
    },
  };
}

function setup(queue: InlineServerQueue<object>) {
  const processed: string[] = [];
  queue.start(async (job) => { processed.push(job.id); });
  return {
    processed,
    deps: { resolveQueue: () => queue },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('requeueOrphanedJobs', () => {
  it('processes a queued job in a project database without a restart', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed, deps } = setup(queue);
    const pool = fakeProjectPool([{ id: 'queued-only', leased: false }]);

    expect(await requeueOrphanedJobs(pool, deps)).toBe(1);
    await tick();

    expect(processed).toEqual(['queued-only']);
  });

  it('drains a backlog larger than one batch over successive ticks', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed, deps } = setup(queue);
    const pool = fakeProjectPool(Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, leased: false })));

    for (let tickNo = 0; tickNo < 3; tickNo += 1) {
      await requeueOrphanedJobs(pool, deps, { batchSize: 2 });
      await tick();
    }

    expect(processed).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
  });

  it('runs a job once when the sweep replays an id that is already waiting or running', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const processed: string[] = [];
    let release!: () => void;
    queue.start(async (job) => {
      processed.push(job.id);
      await new Promise<void>((r) => { release = r; });
    });
    await queue.add('busy', { id: 'busy' });
    await tick();
    await queue.addRecovery('busy', { id: 'busy' });
    await queue.addRecovery('waiting', { id: 'waiting' });
    await queue.addRecovery('waiting', { id: 'waiting' });
    release();
    await tick();
    release();
    await tick();

    expect(processed).toEqual(['busy', 'waiting']);
  });

  it('accepts the same id again after the first run has finished', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed } = setup(queue);
    await queue.add('retry', { id: 'retry' });
    await tick();
    await queue.addRecovery('retry', { id: 'retry' });
    await tick();
    expect(processed).toEqual(['retry', 'retry']);
  });

  it('fails a claimed job the worker would refuse instead of requeueing it', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed, deps } = setup(queue);
    const pool = fakeProjectPool([{ id: 'bad', leased: false }, { id: 'good', leased: false }]);
    const updates: Array<{ text: string; values: unknown[] }> = [];
    const original = pool.query;
    pool.query = async (text: string, values: unknown[] = []) => {
      if (/SET status = 'failed'/.test(text)) { updates.push({ text, values }); return { rows: [] }; }
      return original(text, values);
    };

    const requeued = await requeueOrphanedJobs(pool, { ...deps, classify: async (j) => (j.id === 'bad' ? 'unrunnable' : 'runnable') });
    await tick();

    expect(requeued).toBe(1);
    expect(processed).toEqual(['good']);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values[0]).toEqual(['bad']);
  });

  it('does not hand a leased job out twice', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed, deps } = setup(queue);
    const pool = fakeProjectPool([{ id: 'once', leased: false }]);

    await requeueOrphanedJobs(pool, deps);
    await requeueOrphanedJobs(pool, deps);
    await tick();

    expect(processed).toEqual(['once']);
  });
});

describe('claimQueuedBacklog', () => {
  it('claims only first attempts that are old enough, unleased, and under max_attempts', async () => {
    const queries: string[] = [];
    await claimQueuedBacklog({ query: async (t) => { queries.push(t); return { rows: [] }; } });
    const sql = queries[0]!;
    expect(sql).toContain("status = 'queued'");
    expect(sql).toContain('(attempts = 0 OR next_attempt_at IS NULL)');
    expect(sql).toContain('attempts < max_attempts');
    expect(sql).toContain('next_attempt_at IS NULL OR next_attempt_at <= now()');
    expect(sql).toContain('created_at <= now() - make_interval');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });
});

describe('periodic sweep reaches the orphaned jobs', () => {
  it('keeps requeueing after the boot drain has finished', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    const { processed, deps } = setup(queue);
    const project = fakeProjectPool([]);
    let pass = 0;
    await runRetrySweep({
      listPools: async () => [project],
      sweepPool: async (p) => {
        pass += 1;
        if (pass === 2) p.rows.push({ id: 'late-queued-only', leased: false });
        return requeueOrphanedJobs(p, deps);
      },
      sleep: async () => { await tick(); },
      isClosed: () => false,
      maxPasses: 3,
    });
    await tick();
    expect(processed).toEqual(['late-queued-only']);
  });
});

describe('requeueDrainedJobs summary lane', () => {
  it('routes a stored session-summary job to the summary queue', async () => {
    const lanes: string[] = [];
    const target = (lane: string) => ({ add: async () => { lanes.push(lane); } });
    await requeueDrainedJobs(
      [{
        id: 's1', jobType: 'observation_generate_session_summary', projectId: 'p', teamId: 't',
        agentEventId: null, sourceType: null, sourceId: null, serverSessionId: 'x',
        payload: { kind: 'summary' }, bullmqJobId: 's1',
      }],
      { resolveQueue: (kind) => target(kind) },
    );
    expect(lanes).toEqual(['summary']);
  });
});

describe('runContinuousDrain', () => {
  it('pauses between batches when the same rows reload instead of spinning', async () => {
    const sleeps: number[] = [];
    await runContinuousDrain({
      loadBatch: async () => 1,
      queueDepth: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
      isClosed: () => false,
      batchSize: 10,
      pollMs: 5_000,
      maxIterations: 4,
    });
    expect(sleeps).toEqual([5_000, 5_000, 5_000, 5_000]);
  });
});

describe('accepted counts', () => {
  it('counts only jobs the queue accepted', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    await queue.addRecovery('dup', {});
    const job = (id: string) => ({
      id, jobType: 'observation', projectId: 'p', teamId: 't', agentEventId: null, sourceType: null,
      sourceId: null, serverSessionId: null, payload: {}, bullmqJobId: id,
    });
    const result = await requeueDrainedJobs([job('dup'), job('fresh')], { resolveQueue: () => queue });
    expect(result).toEqual({ requeued: 1, skipped: 1 });
  });
});

describe('requeueOrphanedJobs depth gate', () => {
  const deps = (depth: number) => ({
    resolveQueue: () => new InlineServerQueue<object>('event', 1),
    recoveryDepth: () => depth,
    maxRecoveryDepth: 50,
  });

  it('skips the claim while the recovery lane is deeper than the threshold', async () => {
    const pool = fakeProjectPool([{ id: 'a', leased: false }]);
    expect(await requeueOrphanedJobs(pool, deps(51))).toBe(0);
    expect(pool.rows[0]!.leased).toBe(false);
  });

  it('claims at the threshold', async () => {
    const pool = fakeProjectPool([{ id: 'a', leased: false }]);
    expect(await requeueOrphanedJobs(pool, deps(50))).toBe(1);
    expect(pool.rows[0]!.leased).toBe(true);
  });
});

describe('screenJobs', () => {
  it('keeps the lease on a job whose route is unknown: neither failed nor returned', async () => {
    const queries: string[] = [];
    const pool = { query: async (t: string) => { queries.push(t); return { rows: [] }; } };
    const job = (id: string) => ({
      id, jobType: 'observation', projectId: 'p', teamId: 't', agentEventId: null, sourceType: null,
      sourceId: null, serverSessionId: null, payload: {}, bullmqJobId: id,
    });
    const kept = await screenJobs(pool, [job('ok'), job('bad'), job('unsure'), job('throws')], async (j) => {
      if (j.id === 'throws') throw new Error('boom');
      return j.id === 'ok' ? 'runnable' : j.id === 'bad' ? 'unrunnable' : 'unknown';
    });
    expect(kept.map((j) => j.id)).toEqual(['ok']);
    expect(queries).toHaveLength(1);
  });
});

describe('loadQueuedJobsForDrain backoff', () => {
  const sqlFor = async (respectBackoff?: boolean) => {
    let sql = '';
    await loadQueuedJobsForDrain({ query: async (t) => { sql = t; return { rows: [] }; } }, { respectBackoff });
    return sql;
  };

  it('honors next_attempt_at only when asked', async () => {
    expect(await sqlFor()).not.toContain('next_attempt_at');
    expect(await sqlFor(true)).toContain('(next_attempt_at IS NULL OR next_attempt_at <= now())');
  });
});
