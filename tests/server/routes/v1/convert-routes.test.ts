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

describe('convert routes', () => {
  it('POST /v1/convert/test-connection returns the probe result', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async (url) => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: {} }),
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
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x', cwd: '/home/user/project', serverUrl: 'https://memsmith.example.com', apiKey: 'sk-test-key' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.status).toBe('converted');
    expect(r.body.restartRequired).toBe(true);
  });

  it('POST /v1/convert/test-connection returns 500 JSON when probe rejects', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => { throw new Error('connection refused'); },
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
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
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x', cwd: '/home/user/project', serverUrl: 'https://memsmith.example.com', apiKey: 'sk-test-key' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.code).toBe(500);
    expect(r.body.error).toBe('copy engine failed');
  });

  it('POST /v1/convert/migrate returns 400 when required body fields are missing', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: false, copiedByTable: {} }),
    } as never);

    // Missing cwd, serverUrl, apiKey — old body shape → 400
    const r1 = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r1);
    expect(r1.code).toBe(400);
    expect(r1.body.error).toBe('cwd required');

    // Missing databaseUrl entirely → 400
    const r2 = res();
    await routes['/v1/convert/migrate']({ body: { cwd: '/proj', serverUrl: 'https://s', apiKey: 'k' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r2);
    expect(r2.code).toBe(400);
    expect(r2.body.error).toBe('databaseUrl required');
  });
});
