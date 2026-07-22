// tests/server/routes/v1/write-role-gating.test.ts
//
// Wiring regression test: assert requireWriteRole() is composed into each of
// the 8 content-mutating routes and ABSENT on the /v1/search read route.
//
// Approach: drive setupRoutes() against a fake express app that records the
// middleware chain per (method, path), then identify the requireWriteRole
// guard by its behavior (denies a viewer authContext → 403; allows null role
// → calls next). This avoids the ESM binding-immutability problem that would
// make a module-level spy fragile under bun:test.

import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler, Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Minimal stubs so the constructor + setupRoutes() complete without I/O.
// ---------------------------------------------------------------------------

function makeStubPool() {
  return { query: async () => ({ rows: [] }), connect: async () => ({}) } as unknown as import('../../../../src/storage/postgres/pool.js').PostgresPool;
}

function makeStubQueueManager() {
  return { getQueue: () => null, resolveQueue: () => null } as unknown as import('../../../../src/server/runtime/types.js').ServerQueueManager;
}

// ---------------------------------------------------------------------------
// Fake express app: records registered middleware chains per route.
// ---------------------------------------------------------------------------

interface Registered { method: string; path: string; chain: RequestHandler[] }

function makeFakeApp() {
  const registered: Registered[] = [];
  const app: Record<string, unknown> = {};
  const methods = ['get', 'post', 'delete', 'patch', 'put'];
  for (const m of methods) {
    app[m] = (path: string, ...args: unknown[]) => {
      // Express accepts arrays and individual handlers; flatten both.
      const chain: RequestHandler[] = [];
      for (const a of args) {
        if (Array.isArray(a)) chain.push(...(a as RequestHandler[]));
        else if (typeof a === 'function') chain.push(a as RequestHandler);
      }
      registered.push({ method: m, path, chain });
    };
  }
  // Express also has app.use() for middleware and app.set() for settings.
  app['use'] = () => {};
  app['set'] = () => {};
  return { app, registered };
}

// ---------------------------------------------------------------------------
// Behavioral fingerprint: is this handler requireWriteRole's produced guard?
//
// requireWriteRole() returns a handler that:
//   • denies (403) when authContext.role === 'viewer'
//   • calls next() when authContext.role === null
//
// We probe this by constructing synthetic req/res/next objects.
// ---------------------------------------------------------------------------

function isWriteRoleGuard(fn: RequestHandler): boolean {
  let deniedViewer = false;
  let allowedNull = false;

  // Test 1: viewer role → 403
  const viewerReq = { authContext: { role: 'viewer' } } as unknown as Request;
  const viewerRes = {
    status(code: number) { if (code === 403) deniedViewer = true; return this; },
    json() { return this; },
  } as unknown as Response;
  fn(viewerReq, viewerRes, () => {});

  // Test 2: null role → next()
  const nullReq = { authContext: { role: null } } as unknown as Request;
  const nullRes = { status() { return this; }, json() { return this; } } as unknown as Response;
  fn(nullReq, nullRes, () => { allowedNull = true; });

  return deniedViewer && allowedNull;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('write-role gating wiring', () => {
  it('requireWriteRole is applied to all 8 content-mutating routes and not to /v1/search', () => {
    const { app, registered } = makeFakeApp();

    const routes = new ServerV1PostgresRoutes({
      pool: makeStubPool(),
      queueManager: makeStubQueueManager(),
      authMode: 'api-key',
      allowLocalDevBypass: false,
    });
    routes.setupRoutes(app as unknown as import('express').Application);

    const writePaths: Array<{ method: string; path: string }> = [
      { method: 'post', path: '/v1/events' },
      { method: 'post', path: '/v1/events/batch' },
      { method: 'post', path: '/v1/sessions/start' },
      { method: 'post', path: '/v1/sessions/:id/end' },
      { method: 'post', path: '/v1/memories' },
      { method: 'post', path: '/v1/record-intent' },
      { method: 'delete', path: '/v1/memories/:id' },
      { method: 'delete', path: '/v1/projects/:projectId/memory' },
    ];

    for (const { method, path } of writePaths) {
      const entry = registered.find(r => r.method === method && r.path === path);
      expect(entry, `route ${method.toUpperCase()} ${path} should be registered`).toBeDefined();

      const hasGuard = entry!.chain.some(h => isWriteRoleGuard(h));
      expect(hasGuard, `${method.toUpperCase()} ${path} should have requireWriteRole guard`).toBe(true);
    }

    // Read route must NOT have the write-role guard.
    const search = registered.find(r => r.path === '/v1/search');
    if (search) {
      const hasGuard = search.chain.some(h => isWriteRoleGuard(h));
      expect(hasGuard, '/v1/search must NOT have requireWriteRole guard').toBe(false);
    }
  });
});
