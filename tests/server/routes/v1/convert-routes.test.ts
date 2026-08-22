// tests/server/routes/v1/convert-routes.test.ts
import { describe, it, expect } from 'bun:test';
import { registerConvertRoutes } from '../../../../src/server/routes/v1/ConvertRoutes.js';

// Minimal express-like harness: capture registered handlers and invoke them.
function makeApp() {
  const routes: Record<string, Function> = {};
  return {
    app: { post: (path: string, ..._mw: unknown[]) => { routes[path] = _mw[_mw.length - 1] as Function; } },
    routes,
  };
}
function res() {
  const r: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return r;
}

// The route no longer takes a resolveConvertContext dep. WHICH project gets
// converted now comes from req.authContext (unforgeable, from the api_keys row)
// instead of a marker read off the SERVER's disk — reading the server's own cwd
// meant a request to convert one project copied another's entire memory.
// authContext must therefore carry projectId as well as teamId.
const AUTH = { userId: 'u1', role: 'owner', teamId: 't1', projectId: 'p1' };

describe('convert routes', () => {
  it('POST /v1/convert/test-connection returns the probe result', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: {} }),
    } as never);
    const r = res();
    await routes['/v1/convert/test-connection']({ body: { databaseUrl: 'postgres://x' }, authContext: AUTH }, r);
    expect(r.body.allGreen).toBe(true);
  });

  it('POST /v1/convert/migrate passes the convert result through unchanged', async () => {
    // The route is a pass-through: whatever runConvert reports is what the client
    // sees. (runConvert's own restartRequired=false contract is pinned in
    // tests/server/convert/convert-service.test.ts.)
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: { observations: 3 } }),
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: AUTH }, r);
    expect(r.body.status).toBe('converted');
    expect(r.body.restartRequired).toBe(false);
    expect(r.body.copiedByTable).toEqual({ observations: 3 });
  });

  it('POST /v1/convert/migrate hands the AUTHENTICATED project to convert', async () => {
    // The load-bearing assertion at this layer: the route must forward
    // authContext's project, not anything read from disk or from the body.
    const { app, routes } = makeApp();
    let seen: { projectId?: string; teamId?: string } = {};
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ allGreen: true } as never),
      convert: async (input: any) => {
        seen = { projectId: input.projectId, teamId: input.teamId };
        return { status: 'converted', restartRequired: false, copiedByTable: {} };
      },
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: AUTH }, r);
    expect(seen).toEqual({ projectId: 'p1', teamId: 't1' });
  });

  it('POST /v1/convert/test-connection returns 500 JSON when probe rejects', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => { throw new Error('connection refused'); },
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
    } as never);
    const r = res();
    await routes['/v1/convert/test-connection']({ body: { databaseUrl: 'postgres://x' }, authContext: AUTH }, r);
    expect(r.code).toBe(500);
    expect(r.body.error).toBe('connection refused');
  });

  it('POST /v1/convert/migrate returns 500 JSON when convert rejects', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => { throw new Error('copy engine failed'); },
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: AUTH }, r);
    expect(r.code).toBe(500);
    expect(r.body.error).toBe('copy engine failed');
  });

  it('POST /v1/convert/migrate returns 400 when databaseUrl is missing', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
    } as never);

    // Missing a destination entirely → 400. The MESSAGE changed when convert gained an
    // HTTPS transport: two destination shapes are valid now (serverUrl+teamKey, or
    // databaseUrl), so naming only one would misdirect the user. The status is
    // unchanged, which is what this test is really pinning.
    const r = res();
    await routes['/v1/convert/migrate']({ body: {}, authContext: AUTH }, r);
    expect(r.code).toBe(400);
    expect(r.body.error).toMatch(/server URL and team key, or a database URL/);
  });

  it('POST /v1/convert/migrate returns 400 when the credential carries no project scope', async () => {
    // Replaces the old resolveConvertContext failure case. There is no disk
    // fallback any more: falling back to the server's cwd is precisely what
    // caused the cross-project copy, so an unresolvable project must fail loudly
    // rather than guess.
    const { app, routes } = makeApp();
    let convertCalled = false;
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => { convertCalled = true; return { status: 'converted', restartRequired: false, copiedByTable: {} }; },
    } as never);

    const r = res();
    await routes['/v1/convert/migrate'](
      { body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner' } }, r);
    expect(r.code).toBe(400);
    expect(r.body.error).toContain('no project scope');
    expect(convertCalled).toBe(false);
  });
});
