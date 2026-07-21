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
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.status).toBe('converted');
    expect(r.body.restartRequired).toBe(true);
  });
});
