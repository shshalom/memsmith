// SPDX-License-Identifier: Apache-2.0
//
// Task 5 — wiring regression test: resolveRequestDatabase must be mounted
// into writeAuth/readAuth AFTER the auth middleware (which populates
// req.authContext) and only when a poolRegistry was actually supplied. When
// absent, every DATA-site fallback (`req.databasePool ?? this.options.pool`)
// must resolve to the base pool — this test locks in that resolveRequestDatabase
// is simply never mounted in that case, rather than mounted with a broken
// registry.
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler, Request, Response } from 'express';

function makeStubPool() {
  return { query: async () => ({ rows: [] }), connect: async () => ({}) } as unknown as import('../../../../src/storage/postgres/pool.js').PostgresPool;
}

function makeStubQueueManager() {
  return { getQueue: () => null, resolveQueue: () => null } as unknown as import('../../../../src/server/runtime/types.js').ServerQueueManager;
}

interface Registered { method: string; path: string; chain: RequestHandler[] }

function makeFakeApp() {
  const registered: Registered[] = [];
  const app: Record<string, unknown> = {};
  const methods = ['get', 'post', 'delete', 'patch', 'put'];
  for (const m of methods) {
    app[m] = (path: string, ...args: unknown[]) => {
      const chain: RequestHandler[] = [];
      for (const a of args) {
        if (Array.isArray(a)) chain.push(...(a as RequestHandler[]));
        else if (typeof a === 'function') chain.push(a as RequestHandler);
      }
      registered.push({ method: m, path, chain });
    };
  }
  app['use'] = () => {};
  app['set'] = () => {};
  return { app, registered };
}

// Behavioral fingerprint: is this handler resolveRequestDatabase's produced
// middleware? Feed it a req with authContext.projectId set and no other
// resolveRequestDatabase-specific shape; the real middleware sets
// req.databasePool and calls next(). Other middlewares in the chain (auth
// guards, rate-limit, etc.) either throw on this minimal req shape (caught
// below) or don't touch req.databasePool at all, so this is a safe fingerprint.
async function isDbRoutingMiddleware(fn: RequestHandler): Promise<boolean> {
  const req: any = { authContext: { projectId: 'proj-1', teamId: 'team-1' } };
  const res: any = { status() { return this; }, json() { return this; } };
  let nexted = false;
  try {
    await (fn as any)(req, res, () => { nexted = true; });
  } catch {
    return false;
  }
  return nexted && req.databasePool !== undefined;
}

function fakeRegistry() {
  const calls: unknown[] = [];
  return {
    registry: {
      getPool: async (databaseName: string, ids: unknown) => {
        calls.push({ databaseName, ids });
        return { __fakePool: databaseName };
      },
    } as any,
    calls,
  };
}

describe('ServerV1PostgresRoutes — per-request DB routing mount', () => {
  it('does NOT mount resolveRequestDatabase when poolRegistry is absent', async () => {
    const { app, registered } = makeFakeApp();
    const routes = new ServerV1PostgresRoutes({
      pool: makeStubPool(),
      queueManager: makeStubQueueManager(),
      authMode: 'api-key',
      allowLocalDevBypass: false,
    });
    routes.setupRoutes(app as unknown as import('express').Application);

    const search = registered.find(r => r.path === '/v1/search');
    expect(search, 'POST /v1/search should be registered').toBeDefined();

    for (const handler of search!.chain) {
      const isDbRouting = await isDbRoutingMiddleware(handler);
      expect(isDbRouting).toBe(false);
    }
  });

  it('mounts resolveRequestDatabase on write and read chains when poolRegistry is supplied', async () => {
    const { app, registered } = makeFakeApp();
    const { registry, calls } = fakeRegistry();
    const routes = new ServerV1PostgresRoutes({
      pool: makeStubPool(),
      queueManager: makeStubQueueManager(),
      authMode: 'api-key',
      allowLocalDevBypass: false,
      poolRegistry: registry,
      baseDatabaseName: 'postgres',
      baseProjectId: null,
    });
    routes.setupRoutes(app as unknown as import('express').Application);

    const search = registered.find(r => r.path === '/v1/search');
    const events = registered.find(r => r.path === '/v1/events' && r.method === 'post');
    expect(search, 'POST /v1/search should be registered').toBeDefined();
    expect(events, 'POST /v1/events should be registered').toBeDefined();

    let foundOnRead = false;
    for (const handler of search!.chain) {
      if (await isDbRoutingMiddleware(handler)) { foundOnRead = true; break; }
    }
    let foundOnWrite = false;
    for (const handler of events!.chain) {
      if (await isDbRoutingMiddleware(handler)) { foundOnWrite = true; break; }
    }
    expect(foundOnRead).toBe(true);
    expect(foundOnWrite).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
