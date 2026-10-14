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

  it('re-reads the store once the ttl elapses (natural expiry)', async () => {
    let reads = 0;
    const store = { getTeamOverrides: async () => { reads++; return {}; }, putTeamOverrides: async () => {} } as any;
    let t = 1000;
    const r = new SettingsResolver(store, { ttlMs: 2000, now: () => t });
    await r.resolve('t', 'tiering');
    expect(reads).toBe(1);
    t = 1500; // within ttl -> still cached
    await r.resolve('t', 'tiering');
    expect(reads).toBe(1);
    t = 3001; // past t(1000) + ttl(2000) -> expired
    await r.resolve('t', 'tiering');
    expect(reads).toBe(2);
  });
});

// The installer records the generation provider in ~/.memsmith/settings.json.
// The per-job provider comes from this resolver, which read only team overrides
// and the process environment, so the installer's choice never reached
// generation: a user who picked Claude kept generating with the Ollama default.
describe('SettingsResolver settings-file tier', () => {
  it('uses the provider the installer saved when nothing overrides it', async () => {
    delete process.env.MEMSMITH_SERVER_PROVIDER;
    const r = new SettingsResolver(fakeStore({}), { fileSettings: () => ({ MEMSMITH_SERVER_PROVIDER: 'claude' }) });
    expect(await r.resolve('t', 'provider')).toEqual({ value: 'claude', source: 'file' });
  });

  it('uses the model the installer saved', async () => {
    delete process.env.MEMSMITH_SERVER_MODEL;
    const r = new SettingsResolver(fakeStore({}), { fileSettings: () => ({ MEMSMITH_SERVER_MODEL: 'claude-haiku-4-5-20251001' }) });
    expect(await r.model('t')).toBe('claude-haiku-4-5-20251001');
  });

  it('a dashboard override and the environment both beat the settings file', async () => {
    const file = () => ({ MEMSMITH_SERVER_PROVIDER: 'claude' });
    expect(await new SettingsResolver(fakeStore({ provider: 'gemini' }), { fileSettings: file }).provider('t')).toBe('gemini');
    process.env.MEMSMITH_SERVER_PROVIDER = 'openrouter';
    try {
      expect(await new SettingsResolver(fakeStore({}), { fileSettings: file }).provider('t')).toBe('openrouter');
    } finally {
      delete process.env.MEMSMITH_SERVER_PROVIDER;
    }
  });

  it('ignores an invalid value in the settings file', async () => {
    delete process.env.MEMSMITH_SERVER_PROVIDER;
    const r = new SettingsResolver(fakeStore({}), { fileSettings: () => ({ MEMSMITH_SERVER_PROVIDER: 'gpt' }) });
    expect(await r.resolve('t', 'provider')).toEqual({ value: 'ollama', source: 'default' });
  });
});
