// SPDX-License-Identifier: Apache-2.0
//
// The cookie is a transport for an already-minted key, not a bypass: it must be
// honoured ONLY from a loopback origin. These cases pin that boundary, because
// a cookie accepted from a forwarded/remote request would turn a machine-local
// convenience into remote access.
import { describe, it, expect } from 'bun:test';
import { readLocalKeyCookie, LOCAL_KEY_COOKIE } from '../../../src/server/runtime/local-key-cookie.js';
import {
  isLocalhost,
  hasLoopbackHostHeader,
  hasForwardedClientHeaders,
} from '../../../src/server/middleware/request-auth-helpers.js';

const KEY = 'cmem_cookiekey000000000000000000000000000000';

// Mirrors the gate in postgres-auth.ts: all three conditions must hold.
function cookieKeyFor(req: unknown): string | null {
  const r = req as Parameters<typeof isLocalhost>[0];
  if (!isLocalhost(r) || !hasLoopbackHostHeader(r) || hasForwardedClientHeaders(r)) return null;
  return readLocalKeyCookie((r as unknown as { header: (n: string) => string | undefined }).header('cookie'));
}

function req(opts: { ip?: string; host?: string; headers?: Record<string, string> }) {
  const headers: Record<string, string> = {
    cookie: `${LOCAL_KEY_COOKIE}=${KEY}`,
    host: opts.host ?? '127.0.0.1:38879',
    ...(opts.headers ?? {}),
  };
  return {
    ip: opts.ip ?? '127.0.0.1',
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
    header: (n: string) => headers[n.toLowerCase()],
  };
}

describe('local key cookie is accepted only from loopback', () => {
  it('accepts a loopback request', () => {
    expect(cookieKeyFor(req({}))).toBe(KEY);
  });

  it('accepts IPv6 loopback', () => {
    expect(cookieKeyFor(req({ ip: '::1', host: '[::1]:38879' }))).toBe(KEY);
  });

  it('REJECTS a non-loopback client address', () => {
    expect(cookieKeyFor(req({ ip: '10.0.0.5' }))).toBeNull();
  });

  it('REJECTS a loopback socket with a non-loopback Host header (proxied in)', () => {
    expect(cookieKeyFor(req({ host: 'memsmith.example.com' }))).toBeNull();
  });

  it('REJECTS when x-forwarded-for is present (did not originate here)', () => {
    expect(cookieKeyFor(req({ headers: { 'x-forwarded-for': '203.0.113.9' } }))).toBeNull();
  });

  it('yields null when no cookie is sent at all', () => {
    const r = req({});
    (r as unknown as { header: (n: string) => string | undefined }).header = (n: string) =>
      n.toLowerCase() === 'host' ? '127.0.0.1:38879' : undefined;
    expect(cookieKeyFor(r)).toBeNull();
  });
});
