import { describe, it, expect } from 'bun:test';
import { testConnection, migrate } from '../../src/ui/viewer/views/wizard/wizardData.js';

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
