// SPDX-License-Identifier: Apache-2.0
//
// runJoin over HTTPS: the transport swap, and the guarantees that must survive
// it.
import { describe, it, expect } from 'bun:test';
import { runJoin } from '../../../src/server/convert/join-service.js';

const baseDeps = {
  connect: async () => { throw new Error('connect must NOT be called on the HTTPS path'); },
  hashKey: (r: string) => `H(${r})`,
  deriveServerUrl: (u: string) => u,
  upsertProject: async () => { throw new Error('upsertProject must NOT be called on the HTTPS path'); },
};

function transport(result: any, spy?: (input: any) => void) {
  return { register: async (input: any) => { spy?.(input); return result; } };
}

describe('runJoin over HTTPS', () => {
  it('joins without EVER opening a Postgres connection', async () => {
    // THE POINT OF THE WHOLE CHANGE. baseDeps.connect throws, so if runJoin
    // still reaches for Postgres this test fails loudly.
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'joined', teamId: 'team-1' }) } as never,
      { databaseUrl: 'https://team.example.com', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.status).toBe('joined');
    expect(out.join).toEqual({
      teamId: 'team-1', projectId: 'p1', serverUrl: 'https://team.example.com', apiKey: 'k1',
    });
  });

  it('forwards the key, project and name to the transport', async () => {
    let seen: any = null;
    await runJoin(
      { ...baseDeps, transport: transport({ status: 'joined', teamId: 't' }, i => { seen = i; }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1', projectName: 'svc' },
    );
    expect(seen).toEqual({
      serverUrl: 'https://x', teamKey: 'k1', projectId: 'p1', projectName: 'svc',
    });
  });

  it('passes a rejection reason through unchanged', async () => {
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'failed', error: 'that key has expired' }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBe('that key has expired');
  });

  it('returns NO join payload on failure, so nothing local can be flipped', async () => {
    // The ordering guarantee (spec §2.3): the marker must not flip before the
    // credential resolves, or the project sits in team mode with no key —
    // authenticated as nobody, silently dropping every observation.
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'failed', error: 'nope' }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.join).toBeUndefined();
  });

  it('still uses the POSTGRES path for a postgres:// URL', async () => {
    // The fallback is retained (spec §4.1, decided) for a team already
    // converted against a raw Postgres URL.
    let connected = false, upserted = false;
    const out = await runJoin({
      connect: async () => {
        connected = true;
        return {
          query: async () => ({ rows: [{ team_id: 'team-pg', revoked_at: null, expires_at: null }] }),
          end: async () => {},
        };
      },
      hashKey: (r: string) => `H(${r})`,
      deriveServerUrl: () => 'http://127.0.0.1:38879',
      upsertProject: async () => { upserted = true; },
      transport: transport({ status: 'failed', error: 'HTTPS must not be used here' }),
    } as never, { databaseUrl: 'postgres://u:p@host:5432/db', apiKey: 'k1', projectId: 'p1' });
    expect(connected).toBe(true);
    expect(upserted).toBe(true);
    expect(out.status).toBe('joined');
    expect(out.join?.teamId).toBe('team-pg');
  });

  it('uses Postgres when no transport is supplied at all', async () => {
    // Back-compat: existing callers that never pass a transport keep working.
    let connected = false;
    const out = await runJoin({
      connect: async () => {
        connected = true;
        return {
          query: async () => ({ rows: [{ team_id: 'team-pg', revoked_at: null, expires_at: null }] }),
          end: async () => {},
        };
      },
      hashKey: (r: string) => `H(${r})`,
      deriveServerUrl: () => 'http://127.0.0.1:38879',
      upsertProject: async () => {},
    } as never, { databaseUrl: 'postgres://u:p@h:5432/d', apiKey: 'k1', projectId: 'p1' });
    expect(connected).toBe(true);
    expect(out.status).toBe('joined');
  });

  it('validates its inputs before choosing a transport', async () => {
    const a = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: '', apiKey: 'k', projectId: 'p' });
    expect(a.error).toBe('database URL is required');
    const b = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: 'https://x', apiKey: '', projectId: 'p' });
    expect(b.error).toBe('team key is required');
    const c = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: 'https://x', apiKey: 'k', projectId: '' });
    expect(c.error).toBe('no local project to join with');
  });

  it('reports a transport that throws as a failure, not a crash', async () => {
    const out = await runJoin({
      ...baseDeps,
      transport: { register: async () => { throw new Error('kaboom'); } },
    } as never, { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' });
    expect(out.status).toBe('failed');
    expect(typeof out.error).toBe('string');
  });
});
