// SPDX-License-Identifier: Apache-2.0
//
// Recovery must not compete with live capture.
//
// The continuous drain added earlier refilled the SAME waiting[] that live
// capture uses, served by the SAME worker pool (MEMSMITH_GENERATION_CONCURRENCY,
// default 4). So once the drain loaded a 500-job batch, a brand-new observation
// from the user's current session queued behind up to 500 backlog jobs and
// competed for the same 4 slots. Measured on the live install: throughput on the
// user's own work fell from 368/hr to 35/hr while the backlog drained.
//
// The drain existed to fix stranding (6,958 jobs sat queued for two weeks with
// nothing reloading them). That fix was right; sharing one lane with foreground
// work was not. Recovery is background, best-effort, unbounded in time. Live
// capture is the product.
//
// Contract enforced here:
//   1. A live job NEVER waits behind recovery jobs — strict priority.
//   2. Recovery can never occupy every slot; at least one is reserved for live.
//   3. Recovery yields: while live work is pending or in flight, recovery does
//      not start new jobs.
//   4. Recovery still drains when the system is idle (it must actually finish).
import { describe, it, expect } from 'bun:test';
import { InlineServerQueue } from '../../../src/server/runtime/InlineServerQueue.js';

/** Processor that records execution order and resolves when we say so. */
function controllable() {
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const processor = async (job: { id: string }) => {
    order.push(job.id);
    await new Promise<void>(resolve => gates.set(job.id, resolve));
  };
  return {
    order,
    processor,
    release: (id: string) => { gates.get(id)?.(); gates.delete(id); },
    releaseAll: () => { for (const [, r] of gates) r(); gates.clear(); },
    inFlight: () => gates.size,
  };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('queue priority lanes', () => {
  it('runs a live job BEFORE recovery jobs already waiting', async () => {
    const q = new InlineServerQueue<{ n: number }>('test', 1);
    const c = controllable();
    q.start(c.processor);

    // Backlog arrives first...
    await q.addRecovery('recovery-1', { n: 1 });
    await q.addRecovery('recovery-2', { n: 2 });
    await tick();
    // ...one slot is taken by recovery-1; recovery-2 waits.
    // Now the user does something.
    await q.add('live-1', { n: 3 });
    c.release('recovery-1');
    await tick();

    // live-1 must run; recovery-2 must NOT have started ahead of it. It may not
    // have started at all — with a live job pending, yielding is correct and
    // stronger than merely being ordered after it.
    expect(c.order).toContain('live-1');
    const r2 = c.order.indexOf('recovery-2');
    if (r2 !== -1) expect(c.order.indexOf('live-1')).toBeLessThan(r2);
    c.releaseAll();
  });

  it('reserves a slot so recovery cannot fill the pool', async () => {
    const q = new InlineServerQueue<{ n: number }>('test', 4);
    const c = controllable();
    q.start(c.processor);

    for (let i = 0; i < 10; i += 1) await q.addRecovery(`r-${i}`, { n: i });
    await tick();

    // With concurrency 4, recovery may use at most 3 — one stays free for live.
    expect(c.inFlight()).toBeLessThanOrEqual(3);
    c.releaseAll();
  });

  it('a live job starts immediately even when recovery saturates its budget', async () => {
    const q = new InlineServerQueue<{ n: number }>('test', 4);
    const c = controllable();
    q.start(c.processor);

    for (let i = 0; i < 10; i += 1) await q.addRecovery(`r-${i}`, { n: i });
    await tick();
    const beforeLive = c.inFlight();

    await q.add('live-1', { n: 99 });
    await tick();

    // It ran without waiting for any recovery job to finish.
    expect(c.order).toContain('live-1');
    expect(c.inFlight()).toBe(beforeLive + 1);
    c.releaseAll();
  });

  it('recovery YIELDS while live work is in flight', async () => {
    const q = new InlineServerQueue<{ n: number }>('test', 4);
    const c = controllable();
    q.start(c.processor);

    // Live work occupies the foreground.
    await q.add('live-1', { n: 1 });
    await q.add('live-2', { n: 2 });
    await tick();
    const liveCount = c.order.length;

    // Backlog arrives while live work is still running.
    for (let i = 0; i < 5 ; i += 1) await q.addRecovery(`r-${i}`, { n: i });
    await tick();

    // No recovery job may start while live jobs are active.
    expect(c.order.slice(liveCount).filter(id => id.startsWith('r-'))).toEqual([]);
    c.releaseAll();
  });

  it('recovery drains once the system goes idle', async () => {
    // Yielding must not mean starvation — the backlog has to actually clear.
    const q = new InlineServerQueue<{ n: number }>('test', 2);
    const done: string[] = [];
    q.start(async (job) => { done.push(job.id); });

    await q.add('live-1', { n: 1 });
    for (let i = 0; i < 6; i += 1) await q.addRecovery(`r-${i}`, { n: i });

    // Let the loop settle.
    for (let i = 0; i < 20; i += 1) await tick();

    expect(done).toContain('live-1');
    expect(done.filter(id => id.startsWith('r-'))).toHaveLength(6);
  });

  it('reports the two lanes separately so health is not misleading', async () => {
    const q = new InlineServerQueue<{ n: number }>('test', 1);
    q.start(async () => new Promise<void>(() => { /* never resolves */ }));
    await q.add('live-1', { n: 1 });
    await q.addRecovery('r-1', { n: 2 });
    await q.addRecovery('r-2', { n: 3 });
    await tick();

    // A single blended "queued" number hid the problem: the user could not tell
    // whether 500 queued items were their work or old backlog.
    const counts = await q.getCounts();
    expect(counts.waitingRecovery).toBe(2);
    expect(q.getWaitingCount()).toBe(0); // live lane only
  });

  it('keeps concurrency 1 usable for live work', async () => {
    // With concurrency 1, reserving a slot must not make recovery impossible.
    const q = new InlineServerQueue<{ n: number }>('test', 1);
    const done: string[] = [];
    q.start(async (job) => { done.push(job.id); });
    await q.addRecovery('r-1', { n: 1 });
    for (let i = 0; i < 10; i += 1) await tick();
    expect(done).toEqual(['r-1']);
  });
});
