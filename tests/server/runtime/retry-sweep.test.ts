import { describe, it, expect } from 'bun:test';
import { runRetrySweep } from '../../../src/server/runtime/retry-sweep.js';

describe('runRetrySweep', () => {
  it('keeps sweeping every project database after the boot drain has finished', async () => {
    const swept: string[] = [];
    let listed = 0;
    await runRetrySweep<string>({
      // A project created after boot appears on the second pass.
      listPools: async () => (++listed === 1 ? ['base'] : ['base', 'msp_new']),
      sweepPool: async (p) => { swept.push(p); return 0; },
      sleep: async () => {},
      isClosed: () => false,
      maxPasses: 2,
    });
    expect(swept).toEqual(['base', 'base', 'msp_new']);
  });

  it('survives a failing database and still sweeps the others', async () => {
    const requeued: number[] = [];
    await runRetrySweep<string>({
      listPools: async () => ['broken', 'ok'],
      sweepPool: async (p) => { if (p === 'broken') throw new Error('db down'); return 2; },
      sleep: async () => {},
      isClosed: () => false,
      maxPasses: 1,
      onRequeued: (n) => requeued.push(n),
    });
    expect(requeued).toEqual([2]);
  });

  it('stops when the service closes', async () => {
    let swept = 0;
    await runRetrySweep<string>({
      listPools: async () => ['base'],
      sweepPool: async () => { swept += 1; return 0; },
      sleep: async () => {},
      isClosed: () => true,
      maxPasses: 5,
    });
    expect(swept).toBe(0);
  });
});
