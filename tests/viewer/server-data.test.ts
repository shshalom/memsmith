import { describe, test, expect, afterEach } from 'bun:test';
import { fetchObservations } from '../../src/ui/viewer/utils/serverData.js';

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
