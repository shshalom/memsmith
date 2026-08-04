// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/join/register — the remote half of join-over-HTTPS.
//
// This route is what lets a teammate join with ONLY the team key: no Postgres
// URL, no database password. It performs the same four checks runJoin does
// today (join-service.ts:105-126), server-side.
//
// The security shape it must preserve:
//   - teamId comes from the KEY'S OWN ROW, never from the request body
//   - projectId DOES come from the body, and that is correct here and only here
//     (spec §3.3): the row is CREATED under the authenticated key's own team,
//     so a caller can never reach another team's data
//   - all four rejection reasons stay DISTINCT (spec §2.1)
import { describe, it, expect } from 'bun:test';
import { registerJoinRegisterRoute } from '../../../../src/server/routes/v1/JoinRegisterRoute.js';

function makeApp() {
  const routes: Record<string, Function> = {};
  return {
    app: { post: (path: string, ...mw: unknown[]) => { routes[path] = mw[mw.length - 1] as Function; } },
    routes,
  };
}
function res() {
  const r: any = {
    code: 0, body: null, headers: {} as Record<string, string>,
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  return r;
}
// Deterministic stand-in for sha256 that does NOT embed its input, matching the
// real hash's property. (An `H(${raw})` mock would silently defeat any assertion
// about the raw key not appearing in output.)
const hash = (raw: string) => `h${[...raw].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;

const GOOD = { teamId: 'team-1', revokedAt: null, expiresAt: null };

function deps(over: Partial<Parameters<typeof registerJoinRegisterRoute>[1]> = {}) {
  return {
    hashKey: hash,
    lookupKey: async () => GOOD,
    upsertProject: async () => {},
    ...over,
  } as Parameters<typeof registerJoinRegisterRoute>[1];
}

describe('POST /v1/join/register', () => {
  it('registers the project under the team the KEY names', async () => {
    const { app, routes } = makeApp();
    let seen: { teamId?: string; projectId?: string; name?: string } = {};
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async (teamId, projectId, name) => { seen = { teamId, projectId, name }; },
    }));
    const r = res();
    await routes['/v1/join/register'](
      { body: { teamKey: 'k1', projectId: 'p-new', projectName: 'svc' } }, r,
    );
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ status: 'joined', teamId: 'team-1' });
    expect(seen).toEqual({ teamId: 'team-1', projectId: 'p-new', name: 'svc' });
  });

  it('IGNORES a teamId supplied in the body', async () => {
    // THE SECURITY TEST. The body is attacker-controlled; the team must come
    // from the key's own row. If this ever regresses, a valid key for team A
    // could plant a project in team B.
    const { app, routes } = makeApp();
    let seenTeam = '';
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async (teamId) => { seenTeam = teamId; },
    }));
    const r = res();
    await routes['/v1/join/register'](
      { body: { teamKey: 'k1', projectId: 'p1', teamId: 'team-ATTACKER' } }, r,
    );
    expect(seenTeam).toBe('team-1');
  });

  it('looks the key up by HASH, never storing or comparing the raw key', async () => {
    const { app, routes } = makeApp();
    let seenHash = '';
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async (h) => { seenHash = h; return GOOD; },
    }));
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, res());
    expect(seenHash).toBe(hash('k1'));
  });

  it('rejects an unknown key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({ lookupKey: async () => null }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'nope', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key is not valid for this workspace');
  });

  it('rejects a revoked key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: new Date(), expiresAt: null }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key has been revoked');
  });

  it('rejects an expired key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() - 1000) }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key has expired');
  });

  it('accepts a key whose expiry is in the future', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(200);
  });

  it('rejects a teamless key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: null, revokedAt: null, expiresAt: null }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key is not scoped to a team');
  });

  it('all four rejection reasons are DISTINCT', async () => {
    // Spec §2.1: this is the property the whole body-parameter design exists to
    // preserve. If a refactor routes the key through the auth middleware, all
    // four collapse to one 401 and this test is what catches it.
    const cases: Array<[unknown, string]> = [
      [null, 'that key is not valid for this workspace'],
      [{ teamId: 'team-1', revokedAt: new Date(), expiresAt: null }, 'that key has been revoked'],
      [{ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() - 1) }, 'that key has expired'],
      [{ teamId: null, revokedAt: null, expiresAt: null }, 'that key is not scoped to a team'],
    ];
    const seen = new Set<string>();
    for (const [row, expected] of cases) {
      const { app, routes } = makeApp();
      registerJoinRegisterRoute(app as never, deps({ lookupKey: async () => row as never }));
      const r = res();
      await routes['/v1/join/register']({ body: { teamKey: 'k', projectId: 'p1' } }, r);
      expect(r.body.error).toBe(expected);
      seen.add(r.body.error);
    }
    expect(seen.size).toBe(4);
  });

  it('requires a team key and a projectId', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps());
    const a = res();
    await routes['/v1/join/register']({ body: { projectId: 'p1' } }, a);
    expect(a.code).toBe(422);
    expect(a.body.error).toBe('team key is required');
    const b = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1' } }, b);
    expect(b.code).toBe(422);
    expect(b.body.error).toBe('projectId is required');
  });

  it('never leaks a connection string in ANY response', async () => {
    // Success and failure alike. The whole point of this route is that the
    // database credential stays server-side.
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async () => { throw new Error('connect to postgres://user:pw@host/db failed'); },
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('postgres://');
    expect(JSON.stringify(r.body)).not.toContain('pw@');
  });

  it('reports a registration failure as 500, not as a bad key', async () => {
    // A database problem is not the user's fault and must not be reported as
    // "your key is invalid" — that would send them chasing the wrong fix.
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async () => { throw new Error('deadlock detected'); },
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(500);
    expect(r.body.status).toBe('failed');
  });

  it('installs the rate-limit middleware ahead of the handler', async () => {
    // Spec §3.2: without a limiter this route is a key-guessing oracle that
    // helpfully distinguishes "no such key" from "revoked". Assert the
    // middleware is actually registered, not merely available.
    const seen: unknown[] = [];
    const app = { post: (_p: string, ...mw: unknown[]) => { seen.push(...mw); } };
    const marker = () => {};
    registerJoinRegisterRoute(app as never, deps({ rateLimit: [marker as never] }));
    expect(seen).toContain(marker);
    expect(seen.indexOf(marker)).toBeLessThan(seen.length - 1);
  });
});
