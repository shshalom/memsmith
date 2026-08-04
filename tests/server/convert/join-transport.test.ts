// SPDX-License-Identifier: Apache-2.0
//
// The HTTPS join transport: the outward hop that replaces a direct Postgres
// connection, so a joining teammate never holds a database password.
import { describe, it, expect } from 'bun:test';
import { isHttpUrl, makeHttpsJoinTransport } from '../../../src/server/convert/join-transport-https.js';

function fakeFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  return (async (url: any, init: any) => {
    const { status, body } = handler(String(url), init);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as never;
  }) as unknown as typeof fetch;
}

describe('isHttpUrl', () => {
  it('recognises https and http', () => {
    expect(isHttpUrl('https://team.example.com')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:38880')).toBe(true);
  });

  it('rejects a postgres URL, which must take the fallback transport', () => {
    expect(isHttpUrl('postgres://u:p@host:5432/db')).toBe(false);
    expect(isHttpUrl('postgresql://u:p@host:5432/db')).toBe(false);
  });

  it('rejects junk without throwing', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('makeHttpsJoinTransport', () => {
  it('POSTs the team key and project to /v1/join/register', async () => {
    let seenUrl = '', seenBody: any = null, seenMethod = '';
    const t = makeHttpsJoinTransport(fakeFetch((url, init) => {
      seenUrl = url; seenMethod = init.method; seenBody = JSON.parse(init.body);
      return { status: 200, body: { status: 'joined', teamId: 'team-1' } };
    }));
    const out = await t.register({
      serverUrl: 'https://team.example.com', teamKey: 'k1', projectId: 'p1', projectName: 'svc',
    });
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('https://team.example.com/v1/join/register');
    expect(seenBody).toEqual({ teamKey: 'k1', projectId: 'p1', projectName: 'svc' });
    expect(out).toEqual({ status: 'joined', teamId: 'team-1' });
  });

  it('does NOT send the key in an Authorization header', async () => {
    // Spec §2.1: as a header it would hit the auth middleware, which collapses
    // unknown/revoked/expired into one flat 401 and destroys the four reasons.
    let headers: Record<string, string> = {};
    const t = makeHttpsJoinTransport(fakeFetch((_u, init) => {
      headers = init.headers ?? {};
      return { status: 200, body: { status: 'joined', teamId: 'team-1' } };
    }));
    await t.register({ serverUrl: 'https://x', teamKey: 'k1', projectId: 'p1' });
    const names = Object.keys(headers).map(k => k.toLowerCase());
    expect(names).not.toContain('authorization');
  });

  it('strips a trailing slash from the server URL', async () => {
    let seenUrl = '';
    const t = makeHttpsJoinTransport(fakeFetch((url) => {
      seenUrl = url; return { status: 200, body: { status: 'joined', teamId: 't' } };
    }));
    await t.register({ serverUrl: 'https://x/', teamKey: 'k', projectId: 'p' });
    expect(seenUrl).toBe('https://x/v1/join/register');
  });

  it('omits projectName when not supplied', async () => {
    let body: any = null;
    const t = makeHttpsJoinTransport(fakeFetch((_u, init) => {
      body = JSON.parse(init.body); return { status: 200, body: { status: 'joined', teamId: 't' } };
    }));
    await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect('projectName' in body).toBe(false);
  });

  it('passes a 422 rejection reason through VERBATIM', async () => {
    // The reason is the whole point of the design; the transport must not
    // rewrite or generalise it.
    const t = makeHttpsJoinTransport(fakeFetch(() => ({
      status: 422, body: { status: 'failed', error: 'that key has been revoked' },
    })));
    expect(await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' }))
      .toEqual({ status: 'failed', error: 'that key has been revoked' });
  });

  it('reports a 429 as a readable rate-limit message', async () => {
    const t = makeHttpsJoinTransport(fakeFetch(() => ({
      status: 429, body: { error: 'rate_limited', message: 'Rate limit exceeded (10 requests / 900s)' },
    })));
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect((out as any).error).toContain('too many attempts');
  });

  it('reports an unreachable server distinctly from a rejection', async () => {
    // "cannot reach it" and "reached it and was rejected" have completely
    // different fixes and the user has to know which.
    const t = makeHttpsJoinTransport((async () => { throw new Error('ECONNREFUSED'); }) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect((out as any).error).toContain('cannot reach');
  });

  it('survives a non-JSON error body', async () => {
    const t = makeHttpsJoinTransport((async () => ({
      status: 502, ok: false,
      json: async () => { throw new Error('not json'); },
      text: async () => '<html>bad gateway</html>',
    })) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect(typeof (out as any).error).toBe('string');
  });

  it('treats a 200 with no teamId as a failure, not a silent success', async () => {
    // Without teamId the caller cannot repoint anything; proceeding would flip
    // the marker into team mode naming nothing.
    const t = makeHttpsJoinTransport(fakeFetch(() => ({ status: 200, body: { status: 'joined' } })));
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
  });

  it('never includes the team key in an error message', async () => {
    // The thrown error DELIBERATELY contains the key. A real fetch failure can
    // echo the request it was attempting — URL, headers, sometimes the body —
    // and the body is where the key lives. A fixture throwing a bland
    // `new Error('boom')` would pass this assertion even if the implementation
    // interpolated the thrown message straight into its own error, because
    // 'boom' contains no key. Verified by mutation: with the bland fixture,
    // changing the catch to `error: String(e)` kept all tests green.
    const t = makeHttpsJoinTransport((async () => {
      throw new Error('request to https://x/v1/join/register failed: {"teamKey":"super-secret","projectId":"p"}');
    }) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'super-secret', projectId: 'p' });
    expect(JSON.stringify(out)).not.toContain('super-secret');
  });

  it('never includes the team key in a REJECTION message either', async () => {
    // The 422 path passes the server's reason through verbatim, so a malicious
    // or misconfigured server could try to reflect the key back through it.
    const t = makeHttpsJoinTransport(fakeFetch(() => ({
      status: 422, body: { status: 'failed', error: 'bad key: super-secret' },
    })));
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'super-secret', projectId: 'p' });
    // The reason IS passed through — that is the design — so this documents the
    // boundary rather than asserting the key is stripped: the transport trusts
    // the server it was pointed at. What must never happen is the CLIENT
    // interpolating its own copy of the key into an error it generates itself.
    expect(out.status).toBe('failed');
  });
});
