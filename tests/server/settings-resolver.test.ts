// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SettingsResolver } from '../../src/server/settings/SettingsResolver.js';

// Fake store so the resolver test is pure (no Postgres).
function fakeStore(overrides: Record<string, unknown>) {
  return { getTeamOverrides: async () => overrides, putTeamOverrides: async () => {} } as any;
}

describe('SettingsResolver precedence', () => {
  it('team override wins over env and default', async () => {
    const r = new SettingsResolver(fakeStore({ tiering: false }));
    const res = await r.resolve('t', 'tiering');
    expect(res).toEqual({ value: false, source: 'team' });
  });

  it('env wins over default when no team override', async () => {
    process.env.MEMSMITH_FTS_WEIGHT = '0.7';
    const r = new SettingsResolver(fakeStore({}));
    const res = await r.resolve('t', 'ftsWeight');
    expect(res).toEqual({ value: 0.7, source: 'env' });
    delete process.env.MEMSMITH_FTS_WEIGHT;
  });

  it('code default when neither team nor env', async () => {
    delete process.env.MEMSMITH_RRF_K;
    const r = new SettingsResolver(fakeStore({}));
    const res = await r.resolve('t', 'rrfK');
    expect(res).toEqual({ value: 60, source: 'default' });
  });

  it('malformed team value falls through to default', async () => {
    const r = new SettingsResolver(fakeStore({ ftsWeight: 99 })); // out of range
    delete process.env.MEMSMITH_FTS_WEIGHT;
    const res = await r.resolve('t', 'ftsWeight');
    expect(res.source).toBe('default');
    expect(res.value).toBe(0.3);
  });

  it('typed getters cast correctly', async () => {
    const r = new SettingsResolver(fakeStore({ tiering: true, ftsWeight: 0.4, vecWeight: 0.9, provider: 'claude' }));
    expect(await r.tieringEnabled('t')).toBe(true);
    expect(await r.weights('t')).toEqual({ fts: 0.4, vec: 0.9 });
    expect(await r.provider('t')).toBe('claude');
  });

  it('caches within ttl and invalidate() forces a refetch', async () => {
    let reads = 0;
    const store = { getTeamOverrides: async () => { reads++; return {}; }, putTeamOverrides: async () => {} } as any;
    let t = 1000;
    const r = new SettingsResolver(store, { ttlMs: 2000, now: () => t });
    await r.resolve('t', 'tiering');
    await r.resolve('t', 'tiering'); // cached
    expect(reads).toBe(1);
    r.invalidate('t');
    await r.resolve('t', 'tiering');
    expect(reads).toBe(2);
  });
});
