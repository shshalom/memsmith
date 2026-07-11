// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { InlineServerQueueManager } from '../../src/server/runtime/InlineServerQueueManager.js';

describe('InlineServerQueueManager', () => {
  it('reports active health with engine inline', () => {
    const m = new InlineServerQueueManager();
    const h = m.getHealth();
    expect(h.status).toBe('active');
    expect((h.details as any).engine).toBe('inline');
  });
  it('start dispatches jobs added to a lane', async () => {
    const m = new InlineServerQueueManager();
    const seen: string[] = [];
    m.start('event', async (job) => { seen.push(job.id); });
    await m.getQueueForTest('event').add('j1', { kind: 'event' } as any);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(['j1']);
  });
  it('getQueue exposes observe', () => {
    const m = new InlineServerQueueManager();
    expect(typeof m.getQueue('event').observe).toBe('function');
  });
});
