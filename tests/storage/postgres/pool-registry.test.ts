import { describe, it, expect } from 'bun:test';
import { PoolRegistry } from '../../../src/storage/postgres/pool-registry.js';

function makeDeps(overrides: Partial<any> = {}) {
  const calls = { created: [] as string[], bootstrapped: 0, seeded: 0, admin: [] as string[] };
  const basePool = { __base: true } as any;
  const deps: any = {
    baseConnectionString: 'postgres://u:p@127.0.0.1:55433/postgres',
    basePool,
    baseDatabaseName: 'postgres',
    createPool: (cs: string) => { calls.created.push(cs); return { __cs: cs } as any; },
    adminQuery: async (t: string) => { calls.admin.push(t); return { rows: [] }; },
    bootstrapProject: async () => { calls.bootstrapped += 1; },
    seedHinge: async () => { calls.seeded += 1; },
    ...overrides,
  };
  return { deps, calls, basePool };
}
const IDS = { teamId: 't1', projectId: 'p1' };

describe('PoolRegistry', () => {
  it('returns the base pool for the base database without provisioning', async () => {
    const { deps, calls, basePool } = makeDeps();
    const r = new PoolRegistry(deps);
    expect(await r.getPool('postgres', IDS)).toBe(basePool);
    expect(calls.created).toEqual([]);
    expect(calls.bootstrapped).toBe(0);
  });

  it('provisions once then caches', async () => {
    const { deps, calls } = makeDeps();
    const r = new PoolRegistry(deps);
    const a = await r.getPool('msp_x', IDS);
    const b = await r.getPool('msp_x', IDS);
    expect(a).toBe(b);
    expect(calls.created).toHaveLength(1);
    expect(calls.bootstrapped).toBe(1);
    expect(calls.seeded).toBe(1);
  });

  it('builds the URL by swapping only the database path', async () => {
    const { deps, calls } = makeDeps();
    await new PoolRegistry(deps).getPool('msp_x', IDS);
    expect(calls.created[0]).toBe('postgres://u:p@127.0.0.1:55433/msp_x');
  });

  it('is single-flight: concurrent getPool creates one pool', async () => {
    const { deps, calls } = makeDeps();
    const r = new PoolRegistry(deps);
    const [a, b] = await Promise.all([r.getPool('msp_y', IDS), r.getPool('msp_y', IDS)]);
    expect(a).toBe(b);
    expect(calls.created).toHaveLength(1);
    expect(calls.bootstrapped).toBe(1);
  });

  it('does not cache a failed provision; a later call retries', async () => {
    let fail = true;
    const { deps, calls } = makeDeps({ bootstrapProject: async () => { if (fail) throw new Error('boom'); calls.bootstrapped += 1; } });
    const r = new PoolRegistry(deps);
    await expect(r.getPool('msp_z', IDS)).rejects.toThrow('boom');
    fail = false;
    await r.getPool('msp_z', IDS);           // retry succeeds
    expect(calls.created).toHaveLength(2);   // re-attempted, not served from cache
  });
});
