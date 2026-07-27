import { describe, test, expect, afterEach } from 'bun:test';
import { fetchObservations, fetchProjects } from '../../src/ui/viewer/utils/serverData.js';

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe('serverData', () => {
  test('fetchObservations POSTs /v1/search with filters, no teamId, adapts result', async () => {
    let seenUrl = '', seenBody: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url); seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ observations: [
        { id: 'o1', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'decision',
          content: 'c', metadata: { title: 'T' }, obsType: 'decision', lifecycleState: 'open',
          createdAtEpoch: 1, updatedAtEpoch: 1 } ] }) };
    }) as any;
    const out = await fetchObservations({ query: 'db', type: 'decision', lifecycle: 'open', limit: 10 });
    expect(seenUrl).toContain('/v1/search');
    expect(seenBody.query).toBe('db');
    expect(seenBody.obsType).toBe('decision');
    expect(seenBody.lifecycleState).toBe('open');
    expect('teamId' in seenBody).toBe(false); // NO teamId in UI
    expect(out[0].type).toBe('decision');     // adapted
    expect(out[0].title).toBe('T');
  });
  test('fetchObservations returns [] on non-ok, never throws', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    expect(await fetchObservations({ query: 'x' })).toEqual([]);
  });
});

describe('fetchProjects', () => {
  test('GETs /v1/projects and returns the list as-is', async () => {
    let seenUrl = '';
    const payload = [
      { projectId: '42d7997d-5708-4e26-9e7c-b6f2247085a8', teamId: 'bfc62ef3-…', name: 'ms-p3-fresh', runtime: 'local', isCurrent: true },
    ];
    globalThis.fetch = (async (url: any) => { seenUrl = String(url); return { ok: true, json: async () => payload }; }) as any;
    const out = await fetchProjects();
    expect(seenUrl).toContain('/v1/projects');
    expect(out).toEqual(payload as any);
  });

  // Required degradation (design doc Item 3 UI): the switcher can never offer
  // a project it cannot open, and must not error out when the endpoint is
  // absent -- e.g. an older server build, or a request that fails the
  // loopback gate.
  test('returns [] on 404 (endpoint absent), never throws', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    expect(await fetchProjects()).toEqual([]);
  });

  test('returns [] on network error, never throws', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as any;
    expect(await fetchProjects()).toEqual([]);
  });

  test('returns [] when the response body is not an array', async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ error: 'unexpected shape' }) })) as any;
    expect(await fetchProjects()).toEqual([]);
  });
});
