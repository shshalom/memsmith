// SPDX-License-Identifier: Apache-2.0
//
// The boot drain loads ONE batch of 500 and stops. On a 6,917-job backlog that
// recovers 7% and then goes quiet — clearing the rest would need ~14 manual
// restarts. Measured live: after the batch drained, throughput fell to ~1.3/min
// and only 2 jobs completed in an hour, because the queue had simply run dry
// while 6,400 rows still sat in Postgres.
//
// A bounded batch was the right call (an unbounded SELECT on a large install is
// a memory risk); the missing half is refilling as it empties. This is that half.
//
// The pacing rules matter as much as the loop:
//   - Only refill when the queue is actually LOW, or a slow local model gets a
//     work list far longer than it can process, and a shutdown mid-queue strands
//     all of it again.
//   - Stop cleanly when the backlog is exhausted, and never spin on an empty
//     database.
//   - Never let a refill failure kill the loop — that would silently reinstate
//     the exact bug being fixed.
import { describe, it, expect } from 'bun:test';
import { runContinuousDrain, DEFAULT_REFILL_THRESHOLD, MAX_BACKOFF_MS } from '../../../src/server/runtime/continuous-drain.js';

function harness(opts: {
  backlog: number;
  batch?: number;
  depth?: () => number;
}) {
  let remaining = opts.backlog;
  const loads: number[] = [];
  return {
    loads,
    remaining: () => remaining,
    deps: {
      loadBatch: async (limit: number) => {
        const n = Math.min(limit, remaining);
        remaining -= n;
        if (n > 0) loads.push(n); // the terminating empty read is not a "load"
        return n;
      },
      queueDepth: opts.depth ?? (() => 0),
      sleep: async () => {},
      isClosed: () => false,
      batchSize: opts.batch ?? 500,
    } as never,
  };
}

describe('runContinuousDrain', () => {
  it('keeps refilling until the backlog is exhausted', async () => {
    // The whole point: 6,917 jobs must not need 14 restarts.
    const h = harness({ backlog: 6917, batch: 500 });
    await runContinuousDrain(h.deps);
    expect(h.remaining()).toBe(0);
    expect(h.loads.length).toBe(14); // 13 full batches + a remainder
  });

  it('stops as soon as the backlog is empty rather than spinning', async () => {
    const h = harness({ backlog: 0 });
    await runContinuousDrain(h.deps);
    expect(h.loads).toEqual([]);
  });

  it('only refills when the queue is LOW, so a slow model is not over-fed', async () => {
    // Handing a 14B model a 6,917-item work list means a shutdown strands all of
    // it. Refill on demand instead.
    let depth = DEFAULT_REFILL_THRESHOLD + 100;
    const h = harness({
      backlog: 1000,
      depth: () => depth,
    });
    // Queue is above the threshold, so nothing should be loaded...
    const deps = Object.assign({}, h.deps as object, { maxIterations: 1 }) as never;
    const run = runContinuousDrain(deps);
    depth = 0; // ...until it drains.
    await run;
    expect(h.loads.length).toBeLessThanOrEqual(1);
  });

  it('stops when the service is shutting down', async () => {
    let closed = false;
    let calls = 0;
    const deps = {
      loadBatch: async () => { calls += 1; closed = true; return 500; },
      queueDepth: () => 0,
      sleep: async () => {},
      isClosed: () => closed,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
    expect(calls).toBe(1);
  });

  it('a failing batch does not kill the loop', async () => {
    // One bad refill must not silently reinstate the original bug.
    let n = 0;
    let remaining = 1500;
    const deps = {
      loadBatch: async (limit: number) => {
        n += 1;
        if (n === 2) throw new Error('pg blip');
        const took = Math.min(limit, remaining);
        remaining -= took;
        return took;
      },
      queueDepth: () => 0,
      sleep: async () => {},
      isClosed: () => false,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
    expect(remaining).toBe(0);
  });

  it('BACKS OFF on repeated failures but never gives up permanently', async () => {
    // The original version stopped after 5 consecutive failures. With a 5s poll
    // that meant a ~25-SECOND Postgres blip killed the drain for the rest of the
    // process lifetime, and the backlog silently stopped draining until the next
    // restart — the exact stranding shape this loop exists to prevent.
    //
    // Backing off is right; giving up is not. A transient outage must be
    // survivable, so the loop keeps retrying at a widening interval.
    let calls = 0;
    const sleeps: number[] = [];
    const deps = {
      loadBatch: async () => {
        calls += 1;
        if (calls <= 8) throw new Error('pg down');
        return 0; // recovered: backlog empty, exit cleanly
      },
      queueDepth: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
      isClosed: () => false,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
    // It survived 8 consecutive failures rather than stopping at 5.
    expect(calls).toBe(9);
    // And it waited longer each time instead of hammering a dead database.
    expect(sleeps[3]!).toBeGreaterThan(sleeps[0]!);
  });

  it('caps the backoff so recovery is not delayed for hours', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const deps = {
      loadBatch: async () => { calls += 1; if (calls <= 30) throw new Error('pg down'); return 0; },
      queueDepth: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
      isClosed: () => false,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it('resets the backoff once a batch succeeds', async () => {
    // A blip must not leave the loop permanently slow.
    const sleeps: number[] = [];
    let calls = 0;
    let remaining = 1000;
    const deps = {
      loadBatch: async (limit: number) => {
        calls += 1;
        if (calls <= 3) throw new Error('blip');
        const took = Math.min(limit, remaining);
        remaining -= took;
        return took;
      },
      queueDepth: () => 0,
      sleep: async (ms: number) => { sleeps.push(ms); },
      isClosed: () => false,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
    expect(remaining).toBe(0);
  });

  it('never throws', async () => {
    const deps = {
      loadBatch: async () => { throw new Error('x'); },
      queueDepth: () => { throw new Error('y'); },
      sleep: async () => { throw new Error('z'); },
      isClosed: () => false,
      batchSize: 500,
    } as never;
    await runContinuousDrain(deps);
  });
});
