// tests/server/routes/v1/keys-role-gating.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler, Request, Response } from 'express';

interface Registered { method: string; path: string; chain: RequestHandler[] }
function makeFakeApp() {
  const registered: Registered[] = [];
  const app: Record<string, unknown> = {};
  for (const m of ['get', 'post', 'delete', 'patch', 'put']) {
    app[m] = (path: string, ...args: unknown[]) => {
      const chain: RequestHandler[] = [];
      for (const a of args) { if (Array.isArray(a)) chain.push(...(a as RequestHandler[])); else if (typeof a === 'function') chain.push(a as RequestHandler); }
      registered.push({ method: m, path, chain });
    };
  }
  app['use'] = () => {}; app['set'] = () => {};
  return { app, registered };
}
function pool() { return { query: async () => ({ rows: [] }), connect: async () => ({}) } as any; }
function queue() { return { getQueue: () => null, resolveQueue: () => null } as any; }

// requireRole('admin'): denies member (403), allows admin (next).
function probeAdmin(fn: RequestHandler) {
  let deniedMember = false, allowedAdmin = false;
  const memReq = { authContext: { role: 'member' } } as unknown as Request;
  const memRes = { status(c: number) { if (c === 403) deniedMember = true; return this; }, json() { return this; } } as unknown as Response;
  fn(memReq, memRes, () => {});
  const admReq = { authContext: { role: 'admin' } } as unknown as Request;
  const admRes = { status() { return this; }, json() { return this; } } as unknown as Response;
  fn(admReq, admRes, () => { allowedAdmin = true; });
  return { deniedMember, allowedAdmin };
}

describe('key-mint role gating', () => {
  it('POST /v1/keys requires >=admin (member denied, admin allowed)', () => {
    const { app, registered } = makeFakeApp();
    const routes = new ServerV1PostgresRoutes({ pool: pool(), queueManager: queue() } as any);
    routes.setupRoutes(app as any);
    const reg = registered.find(r => r.method === 'post' && r.path === '/v1/keys')!;
    const hasAdminGate = reg.chain.map(probeAdmin).some(r => r.deniedMember && r.allowedAdmin);
    expect(hasAdminGate).toBe(true);
  });
});
