import { describe, it, expect } from 'bun:test';
import { testConnection, migrate, fetchOwnerEstablished } from '../../src/ui/viewer/views/wizard/wizardData.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe('wizardData', () => {
  it('testConnection returns the parsed probe result on 200', async () => {
    const probe = { connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] };
    const r = await testConnection('postgres://x', fakeFetch(200, probe));
    expect(r.allGreen).toBe(true);
  });
  it('testConnection degrades (never throws) on network error', async () => {
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const r = await testConnection('postgres://x', boom);
    expect(r.allGreen).toBe(false);
    expect(r.error).toBeDefined();
  });
  it('migrate degrades to verify_failed on error', async () => {
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const r = await migrate('postgres://x', boom);
    expect(r.status).toBe('verify_failed');
    expect(r.restartRequired).toBe(false);
  });
});

// The wizard asks the server whether a real owner already exists so it can skip
// asking a single-user install to sign in. Every failure mode must fail SAFE —
// i.e. report false and keep the sign-in step — because a false positive would
// skip the step and then strand the user at the owner-gated convert call.
describe('fetchOwnerEstablished', () => {
  it('reports true only when the server says ownerEstablished', async () => {
    expect(await fetchOwnerEstablished(fakeFetch(200, { ownerEstablished: true }))).toBe(true);
  });

  it('reports false when the server says the caller is not an owner', async () => {
    expect(await fetchOwnerEstablished(fakeFetch(200, { ownerEstablished: false }))).toBe(false);
  });

  it('fails safe on a non-200 (e.g. 404 no marker, 401 unauthenticated)', async () => {
    expect(await fetchOwnerEstablished(fakeFetch(404, {}))).toBe(false);
    expect(await fetchOwnerEstablished(fakeFetch(401, {}))).toBe(false);
  });

  it('fails safe on a network error', async () => {
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await fetchOwnerEstablished(boom)).toBe(false);
  });

  it('fails safe when the field is missing or not a strict boolean true', async () => {
    // Guards against a truthy-but-wrong value (e.g. the string "false") being
    // read as ownership.
    expect(await fetchOwnerEstablished(fakeFetch(200, {}))).toBe(false);
    expect(await fetchOwnerEstablished(fakeFetch(200, { ownerEstablished: 'false' }))).toBe(false);
    expect(await fetchOwnerEstablished(fakeFetch(200, { ownerEstablished: 1 }))).toBe(false);
    expect(await fetchOwnerEstablished(fakeFetch(200, null))).toBe(false);
  });

  it('fails safe when the body is not JSON', async () => {
    const badJson = (async () => ({
      ok: true, status: 200, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    expect(await fetchOwnerEstablished(badJson)).toBe(false);
  });
});
