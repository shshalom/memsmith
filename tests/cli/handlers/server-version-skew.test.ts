import { describe, it, expect } from 'bun:test';
import { probeServerVersion, serverVersionSkewNotice } from '../../../src/cli/handlers/server-version-skew.js';

describe('serverVersionSkewNotice', () => {
  it('tells the user to restart when the server runs another version', () => {
    const notice = serverVersionSkewNotice('13.10.2', '13.11.0');
    expect(notice).toContain('running 13.10.2');
    expect(notice).toContain('plugin is 13.11.0');
    expect(notice).toContain('memsmith restart');
  });

  it('stays quiet when versions match or either is unknown', () => {
    expect(serverVersionSkewNotice('13.11.0', '13.11.0')).toBeNull();
    expect(serverVersionSkewNotice(undefined, '13.11.0')).toBeNull();
    expect(serverVersionSkewNotice('13.11.0', '')).toBeNull();
  });
});

describe('probeServerVersion', () => {
  it('reads the version from /api/health', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => { url = u; return Response.json({ version: '13.10.2' }); }) as unknown as typeof fetch;
    expect(await probeServerVersion('http://127.0.0.1:1/', fetchImpl)).toBe('13.10.2');
    expect(url).toBe('http://127.0.0.1:1/api/health');
  });

  it('returns undefined instead of throwing when the server is down', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await probeServerVersion('http://127.0.0.1:1', fetchImpl)).toBeUndefined();
  });
});
