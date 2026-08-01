// SPDX-License-Identifier: Apache-2.0
//
// Joining an existing team workspace.
//
// The only documented join path was `memsmith join --key <k> --url <u>` — a
// command that DOES NOT EXIST in the CLI. Every teammate following the wizard's
// final step hit "unknown command". So this is not a refactor of a working flow;
// there was no working flow.
//
// Join is deliberately NOT a variant of convert. Convert is the OWNER copying
// local memory up and flipping. The joiner has nothing to copy — no copy, no
// verify, no attribution re-stamp. What a join must establish is authorization
// and registration, in an order where each step gates the next.
//
// Most of this file is failure modes, because they are what a real teammate
// hits: wrong URL, wrong key, revoked key, expired key, key with no team. Each
// must produce a sentence a person can act on — this is driven by a form, and a
// stack trace is not an error message.
import { describe, it, expect } from 'bun:test';
import { runJoin, type JoinDeps } from '../../../src/server/convert/join-service.js';

const KEY = 'cmem_teamkey';
const HASH = 'hash-of-teamkey';

function deps(overrides: Partial<JoinDeps> = {}, rows: Array<Record<string, unknown>> = []): JoinDeps {
  return {
    connect: async () => ({ query: async () => ({ rows }) }),
    hashKey: () => HASH,
    deriveServerUrl: () => 'http://127.0.0.1:38879',
    upsertProject: async () => {},
    ...overrides,
  };
}

const INPUT = { databaseUrl: 'postgres://host/db', apiKey: KEY, projectId: 'proj-local' };

describe('runJoin — success', () => {
  it('returns the join payload for a valid key', async () => {
    const out = await runJoin(deps({}, [{ team_id: 'team-1', revoked_at: null, expires_at: null }]), INPUT);
    expect(out.status).toBe('joined');
    expect(out.join).toEqual({
      teamId: 'team-1',
      projectId: 'proj-local',
      serverUrl: 'http://127.0.0.1:38879',
      apiKey: KEY,
    });
  });

  it('registers the project under the team BEFORE returning', async () => {
    // The joiner's writes need a projects row to reference, or every capture
    // fails an FK after the flip has already happened.
    const seen: Array<[string, string]> = [];
    await runJoin(
      deps({ upsertProject: async (_p, t, proj) => { seen.push([t, proj]); } },
        [{ team_id: 'team-1', revoked_at: null, expires_at: null }]),
      INPUT,
    );
    expect(seen).toEqual([['team-1', 'proj-local']]);
  });

  it('bootstraps the remote schema when the owner has not converted yet', async () => {
    let bootstrapped = false;
    await runJoin(
      deps({ bootstrapSchema: async () => { bootstrapped = true; } },
        [{ team_id: 'team-1', revoked_at: null, expires_at: null }]),
      INPUT,
    );
    expect(bootstrapped).toBe(true);
  });

  it('closes the remote pool even on success', async () => {
    // One leaked pool per join attempt is a slow leak in a long-lived server.
    let ended = false;
    await runJoin(
      deps({ connect: async () => ({
        query: async () => ({ rows: [{ team_id: 'team-1', revoked_at: null, expires_at: null }] }),
        end: async () => { ended = true; },
      }) }),
      INPUT,
    );
    expect(ended).toBe(true);
  });
});

describe('runJoin — the failures a real teammate hits', () => {
  it('unreachable database says so, distinctly from a bad key', async () => {
    // "cannot connect" and "wrong key" have completely different fixes.
    const out = await runJoin(
      deps({ connect: async () => { throw new Error('ECONNREFUSED'); } }),
      INPUT,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/cannot reach/i);
  });

  it('a key the workspace does not know is rejected', async () => {
    const out = await runJoin(deps({}, []), INPUT);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/not valid/i);
  });

  it('a REVOKED key is rejected', async () => {
    // Revocation must actually revoke — otherwise removing someone does nothing.
    const out = await runJoin(
      deps({}, [{ team_id: 'team-1', revoked_at: new Date().toISOString(), expires_at: null }]),
      INPUT,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/revoked/i);
  });

  it('an EXPIRED key is rejected', async () => {
    const out = await runJoin(
      deps({}, [{ team_id: 'team-1', revoked_at: null, expires_at: new Date(Date.now() - 1000).toISOString() }]),
      INPUT,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/expired/i);
  });

  it('accepts a key whose expiry is in the FUTURE', async () => {
    const out = await runJoin(
      deps({}, [{ team_id: 'team-1', revoked_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() }]),
      INPUT,
    );
    expect(out.status).toBe('joined');
  });

  it('a key with no team is rejected rather than joined unscoped', async () => {
    // Joining with it would authenticate but route nowhere.
    const out = await runJoin(deps({}, [{ team_id: null, revoked_at: null, expires_at: null }]), INPUT);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/not scoped to a team/i);
  });

  it('a failed project registration does NOT report success', async () => {
    // Reporting joined here would flip the marker against a team the project is
    // not registered with — team mode with no home for its writes.
    const out = await runJoin(
      deps({ upsertProject: async () => { throw new Error('permission denied'); } },
        [{ team_id: 'team-1', revoked_at: null, expires_at: null }]),
      INPUT,
    );
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/could not register/i);
  });

  it('NEVER returns a join payload on failure', async () => {
    // The client flips the marker on `join`. Any failure carrying one would
    // strand the project in team mode.
    for (const d of [
      deps({ connect: async () => { throw new Error('nope'); } }),
      deps({}, []),
      deps({}, [{ team_id: null, revoked_at: null, expires_at: null }]),
    ]) {
      const out = await runJoin(d, INPUT);
      expect(out.join).toBeUndefined();
    }
  });

  it('closes the pool even when the join fails', async () => {
    let ended = false;
    await runJoin(
      deps({ connect: async () => ({ query: async () => ({ rows: [] }), end: async () => { ended = true; } }) }),
      INPUT,
    );
    expect(ended).toBe(true);
  });
});

describe('runJoin — input validation', () => {
  it('requires a database URL, a key, and a local project', async () => {
    const cases: Array<[Partial<typeof INPUT>, RegExp]> = [
      [{ databaseUrl: '' }, /database URL is required/i],
      [{ apiKey: '   ' }, /key is required/i],
      [{ projectId: '' }, /no local project/i],
    ];
    for (const [patch, expected] of cases) {
      const out = await runJoin(deps(), { ...INPUT, ...patch });
      expect(out.status).toBe('failed');
      expect(out.error).toMatch(expected);
    }
  });

  it('does not connect at all when input is invalid', async () => {
    // Validation before I/O: a blank form must not open a socket.
    let connected = false;
    await runJoin(
      deps({ connect: async () => { connected = true; return { query: async () => ({ rows: [] }) }; } }),
      { ...INPUT, apiKey: '' },
    );
    expect(connected).toBe(false);
  });
});
