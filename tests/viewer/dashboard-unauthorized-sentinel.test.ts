// SPDX-License-Identifier: Apache-2.0
//
// fetchDashboard used to collapse EVERY failure to null, so a 401 was
// indistinguishable from "no data" and the UI blamed the data layer -- that
// conflation is why a pure auth failure was once misdiagnosed as a database
// problem. It now returns a distinct sentinel for 401/403.
//
// The sentinel is a Symbol, which is TRUTHY. That is the trap this file exists
// to guard: any consumer doing `value ?? null` passes the sentinel straight
// into state, and downstream property reads render garbage. Consumers must
// either branch on isUnauthorized or launder the value through dataOrNull.
import { describe, it, expect, afterEach } from 'bun:test';
import { fetchDashboard, isUnauthorized, dataOrNull } from '../../src/ui/viewer/utils/serverData';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function respondWith(status: number, body: unknown = {}) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('fetchDashboard distinguishes auth failure from missing data', () => {
  it('returns the sentinel on 401', async () => {
    respondWith(401);
    expect(isUnauthorized(await fetchDashboard('metrics'))).toBe(true);
  });

  it('returns the sentinel on 403', async () => {
    respondWith(403);
    expect(isUnauthorized(await fetchDashboard('metrics'))).toBe(true);
  });

  it('returns null on other failures, NOT the sentinel', async () => {
    respondWith(500);
    const v = await fetchDashboard('metrics');
    expect(v).toBeNull();
    expect(isUnauthorized(v)).toBe(false);
  });

  it('returns the payload on success and does not flag it', async () => {
    respondWith(200, { total: 7 });
    const v = await fetchDashboard('metrics');
    expect(v).toEqual({ total: 7 });
    expect(isUnauthorized(v)).toBe(false);
  });

  it('returns null when fetch itself throws', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await fetchDashboard('metrics')).toBeNull();
  });
});

describe('the sentinel is truthy — consumers must launder it', () => {
  it('is truthy, so `?? null` would NOT filter it (the regression this guards)', async () => {
    respondWith(401);
    const v = await fetchDashboard('cost');
    expect(Boolean(v)).toBe(true);      // the trap
    expect(v ?? null).not.toBeNull();   // proves `?? null` is insufficient
  });

  it('dataOrNull collapses the sentinel to null', async () => {
    respondWith(401);
    expect(dataOrNull(await fetchDashboard('cost'))).toBeNull();
  });

  it('dataOrNull passes real data through untouched', () => {
    const payload = { spend: 1.23 };
    expect(dataOrNull(payload)).toBe(payload);
    expect(dataOrNull(null)).toBeNull();
  });
});
