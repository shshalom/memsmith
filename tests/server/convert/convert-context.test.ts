import { describe, it, expect } from 'bun:test';
import { deriveServerUrl, makeResolveConvertContext } from '../../../src/server/convert/convert-context.js';

describe('deriveServerUrl', () => {
  it('local host → http + 38879', () => {
    expect(deriveServerUrl('postgres://u:p@localhost:5432/db')).toBe('http://localhost:38879');
    expect(deriveServerUrl('postgres://u:p@127.0.0.1:5432/db')).toBe('http://127.0.0.1:38879');
  });
  it('remote host → https, no port', () => {
    expect(deriveServerUrl('postgres://u:p@team.example.com:5432/db')).toBe('https://team.example.com');
  });
  it('existing serverUrl takes precedence', () => {
    expect(deriveServerUrl('postgres://u:p@team.example.com/db', 'https://override.example')).toBe('https://override.example');
  });
  it('unparseable url throws', () => {
    expect(() => deriveServerUrl('not a url')).toThrow();
  });
});

describe('makeResolveConvertContext', () => {
  const base = {
    cwd: '/proj/b',
    readScope: () => ({ teamId: 't1', projectId: 'p1' }),
    resolveKey: () => 'cmem_existing',
    mintKey: async (_t: string, _p: string, _url: string) => 'cmem_minted',
  };

  it('resolves full context with an existing key (no mint)', async () => {
    let minted = false;
    const resolve = makeResolveConvertContext({ ...base, mintKey: async () => { minted = true; return 'x'; } });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect(ctx).toEqual({ cwd: '/proj/b', teamId: 't1', projectId: 'p1', serverUrl: 'http://localhost:38879', apiKey: 'cmem_existing' });
    expect(minted).toBe(false);
  });

  it('mints the key (with databaseUrl) when the store misses', async () => {
    let seenUrl = '';
    const resolve = makeResolveConvertContext({
      ...base,
      resolveKey: () => null,
      mintKey: async (_t, _p, url) => { seenUrl = url; return 'cmem_minted'; },
    });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect((ctx as any).apiKey).toBe('cmem_minted');
    expect(seenUrl).toBe('postgres://u:p@localhost:5432/db');
  });

  it('returns an error when local scope is unresolvable', async () => {
    const resolve = makeResolveConvertContext({ ...base, readScope: () => null });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect(ctx).toEqual({ error: 'no local project identity — run inside a MemSmith project' });
  });
});
