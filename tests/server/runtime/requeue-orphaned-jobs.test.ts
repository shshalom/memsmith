import { describe, it, expect } from 'bun:test';
import { InlineServerQueue } from '../../../src/server/runtime/InlineServerQueue.js';
import { requeueOrphanedJobs, claimQueuedBacklog } from '../../../src/server/runtime/generation-drain.js';
import { runRetrySweep } from '../../../src/server/runtime/retry-sweep.js';

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
    deps: {
      resolveQueue: () => queue,
      isQueueIdle: () => queue.getWaitingCount() === 0 && queue.getRecoveryWaitingCount() === 0,
    },
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

  it('does not load a job again while the queue still holds work', async () => {
    const queue = new InlineServerQueue<object>('event', 1);
    await queue.addRecovery('already-in-memory', { id: 'already-in-memory' });
    const pool = fakeProjectPool([{ id: 'already-in-memory', leased: false }]);

    expect(await requeueOrphanedJobs(pool, {
      resolveQueue: () => queue,
      isQueueIdle: () => queue.getRecoveryWaitingCount() === 0,
    })).toBe(0);
    expect(pool.rows[0]!.leased).toBe(false);
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
    expect(sql).toContain('attempts = 0');
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
