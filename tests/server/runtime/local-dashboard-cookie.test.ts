// SPDX-License-Identifier: Apache-2.0
//
// The local dashboard could not load its own data. Local runtime mints a base
// key into CredentialStore at session start (by design -- "key-everywhere local
// identity"), and that key authenticates fine, but nothing ever handed it to
// the browser: the viewer sends no Authorization header and the server injected
// no credential. Under the shipped `api-key` default every /dashboard/* and
// /v1/* fetch came back 401, fetchDashboard turned that into null, and the UI
// rendered "Failed to load dashboard data" -- on a fresh install AND on a store
// with thousands of observations.
//
// Fix: GET / issues an HttpOnly loopback-only cookie carrying the base key, and
// the auth middleware accepts that cookie as a key source. A cookie (not an
// injected global + header) because EventSource cannot send custom headers, so
// SSE would otherwise stay broken, and because HttpOnly keeps the key out of JS.
import { describe, it, expect } from 'bun:test';
import { buildLocalKeyCookie, readLocalKeyCookie, LOCAL_KEY_COOKIE } from '../../../src/server/runtime/local-key-cookie.js';

const KEY = 'cmem_testkey0000000000000000000000000000000000';

describe('local key cookie — issuing', () => {
  it('marks the cookie HttpOnly so page scripts cannot read the key', () => {
    expect(buildLocalKeyCookie(KEY)).toContain('HttpOnly');
  });

  it('sets SameSite=Strict so another origin cannot drive authenticated calls', () => {
    expect(buildLocalKeyCookie(KEY)).toContain('SameSite=Strict');
  });

  it('scopes the cookie to the whole app so /v1 and /dashboard both receive it', () => {
    expect(buildLocalKeyCookie(KEY)).toContain('Path=/');
  });

  it('carries the key value under the expected name', () => {
    expect(buildLocalKeyCookie(KEY)).toStartWith(`${LOCAL_KEY_COOKIE}=${KEY}`);
  });

  it('percent-encodes the value so a stray separator cannot forge attributes', () => {
    const cookie = buildLocalKeyCookie('abc;Path=/evil');
    expect(cookie).not.toContain(';Path=/evil');
    expect(cookie).toContain(encodeURIComponent('abc;Path=/evil'));
  });
});

describe('local key cookie — reading', () => {
  it('extracts the key from a lone cookie', () => {
    expect(readLocalKeyCookie(`${LOCAL_KEY_COOKIE}=${KEY}`)).toBe(KEY);
  });

  it('extracts the key when other cookies surround it', () => {
    expect(readLocalKeyCookie(`a=1; ${LOCAL_KEY_COOKIE}=${KEY}; b=2`)).toBe(KEY);
  });

  it('round-trips a percent-encoded value', () => {
    const raw = 'weird value;x';
    const header = buildLocalKeyCookie(raw).split(';')[0]!;
    expect(readLocalKeyCookie(header)).toBe(raw);
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(readLocalKeyCookie(`evil_${LOCAL_KEY_COOKIE}=stolen`)).toBeNull();
  });

  it('returns null for an absent cookie, empty header, or empty value', () => {
    expect(readLocalKeyCookie('other=1')).toBeNull();
    expect(readLocalKeyCookie('')).toBeNull();
    expect(readLocalKeyCookie(`${LOCAL_KEY_COOKIE}=`)).toBeNull();
  });
});
