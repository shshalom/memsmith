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

const fakeResolve = async (_databaseUrl: string) => ({
  cwd: '/proj', teamId: 't1', projectId: 'p1',
  serverUrl: 'http://localhost:38879', apiKey: 'cmem_k',
});

describe('convert routes', () => {
  it('POST /v1/convert/test-connection returns the probe result', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async (url) => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: {} }),
      resolveConvertContext: fakeResolve,
    } as never);
    const r = res();
    await routes['/v1/convert/test-connection']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.allGreen).toBe(true);
  });

  it('POST /v1/convert/migrate returns converted + restartRequired', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: { observations: 3 } }),
      resolveConvertContext: fakeResolve,
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.status).toBe('converted');
    expect(r.body.restartRequired).toBe(true);
  });

  it('POST /v1/convert/test-connection returns 500 JSON when probe rejects', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => { throw new Error('connection refused'); },
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
      resolveConvertContext: fakeResolve,
    } as never);
    const r = res();
    await routes['/v1/convert/test-connection']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.code).toBe(500);
    expect(r.body.error).toBe('connection refused');
  });

  it('POST /v1/convert/migrate returns 500 JSON when convert rejects', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => { throw new Error('copy engine failed'); },
      resolveConvertContext: fakeResolve,
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.code).toBe(500);
    expect(r.body.error).toBe('copy engine failed');
  });

  it('POST /v1/convert/migrate returns 400 when databaseUrl is missing', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
      resolveConvertContext: fakeResolve,
    } as never);

    // Missing databaseUrl entirely → 400
    const r = res();
    await routes['/v1/convert/migrate']({ body: {}, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('databaseUrl required');
  });

  it('POST /v1/convert/migrate returns 400 with error when resolveConvertContext cannot resolve scope', async () => {
    const { app, routes } = makeApp();
    let convertCalled = false;
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => { convertCalled = true; return { status: 'converted', restartRequired: false, copiedByTable: {} }; },
      resolveConvertContext: async () => ({ error: 'no local project identity — run inside a MemSmith project' }),
    } as never);

    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('no local project identity — run inside a MemSmith project');
    expect(convertCalled).toBe(false);
  });
});
