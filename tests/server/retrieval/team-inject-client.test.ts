// SPDX-License-Identifier: Apache-2.0
// The team-inject bridge client: a worker-mode SessionStart hook fetches
// cross-team memory from the SERVER-mode Postgres API (POST /v1/search) with a
// scoped read key. Tested with an injected fetch (no network).
import { describe, it, expect } from 'bun:test';
import { fetchTeamMemory } from '../../../src/server/retrieval/team-inject-client.js';

const okFetch = (observations: any[]) =>
  (async (_url: string, _init: any) => ({
    ok: true,
    status: 200,
    json: async () => ({ observations }),
  })) as unknown as typeof fetch;

describe('fetchTeamMemory', () => {
  it('returns observation contents on a successful search', async () => {
    const rows = await fetchTeamMemory(
      { serverUrl: 'https://mem.example.com', apiKey: 'k', projectId: 'p1', teamId: 'tm1', query: 'auth' },
      okFetch([{ id: 'o1', content: 'auth uses JWT', metadata: {} }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('auth uses JWT');
  });

  it('returns [] when serverUrl or apiKey is missing (bridge disabled)', async () => {
    expect(await fetchTeamMemory({ serverUrl: '', apiKey: 'k', projectId: 'p1', teamId: 'tm1', query: 'x' }, okFetch([{ id: 'a', content: 'a', metadata: {} }]))).toEqual([]);
    expect(await fetchTeamMemory({ serverUrl: 'u', apiKey: '', projectId: 'p1', teamId: 'tm1', query: 'x' }, okFetch([{ id: 'a', content: 'a', metadata: {} }]))).toEqual([]);
  });

  it('returns [] and never throws on a non-ok response', async () => {
    const badFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await fetchTeamMemory({ serverUrl: 'u', apiKey: 'k', projectId: 'p1', teamId: 'tm1', query: 'x' }, badFetch)).toEqual([]);
  });

  it('returns [] and never throws when fetch rejects (network error)', async () => {
    const throwFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await fetchTeamMemory({ serverUrl: 'u', apiKey: 'k', projectId: 'p1', teamId: 'tm1', query: 'x' }, throwFetch)).toEqual([]);
  });

  it('sends the scoped key and a well-formed search body', async () => {
    let captured: any = null;
    const spyFetch = (async (url: string, init: any) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ observations: [] }) };
    }) as unknown as typeof fetch;
    await fetchTeamMemory({ serverUrl: 'https://mem.example.com/', apiKey: 'secret', projectId: 'p1', teamId: 'tm1', query: 'auth', limit: 7 }, spyFetch);
    expect(captured.url).toBe('https://mem.example.com/v1/search');
    expect(captured.init.method).toBe('POST');
    expect(captured.init.headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(captured.init.body);
    expect(body.projectId).toBe('p1');
    expect(body.query).toBe('auth');
    expect(body.limit).toBe(7);
  });
});
