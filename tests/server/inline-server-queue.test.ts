// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { InlineServerQueue } from '../../src/server/runtime/InlineServerQueue.js';

async function flush() { await new Promise((r) => setTimeout(r, 20)); }

describe('InlineServerQueue', () => {
  it('drains enqueued jobs through the processor', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    const seen: number[] = [];
    q.start(async (job) => { seen.push(job.data.n); });
    await q.add('a', { n: 1 });
    await q.add('b', { n: 2 });
    await flush();
    expect(seen.sort()).toEqual([1, 2]);
  });

  it('reports completed count and fires onCompleted', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    let completed = 0;
    q.observe({ onCompleted: () => { completed += 1; } });
    q.start(async () => {});
    await q.add('a', { n: 1 });
    await flush();
    const counts = await q.getCounts();
    expect(counts.completed).toBe(1);
    expect(completed).toBe(1);
  });

  it('a throwing processor increments failed and does not crash', async () => {
    const q = new InlineServerQueue<{ n: number }>('event');
    let failed = 0;
    q.observe({ onFailed: () => { failed += 1; } });
    q.start(async () => { throw new Error('boom'); });
    await q.add('a', { n: 1 });
    await flush();
    const counts = await q.getCounts();
    expect(counts.failed).toBe(1);
    expect(failed).toBe(1);
  });

  it('start twice throws', () => {
    const q = new InlineServerQueue('event');
    q.start(async () => {});
    expect(() => q.start(async () => {})).toThrow(/already started/i);
  });
});
