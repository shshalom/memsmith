// tests/server/routes/v1/ownership-delete.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler } from 'express';

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

// Pool stub: SELECT (getObservationForDelete) returns `row`; DELETE returns rowCount 1.
function makePool(row: { kind: string; created_by_user_id: string | null } | null) {
  return {
    query: async (sql: string) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [], rowCount: row ? 1 : 0 };
    },
    connect: async () => ({}),
  } as unknown as import('../../../../src/storage/postgres/pool.js').PostgresPool;
}
function makeQueue() { return { getQueue: () => null, resolveQueue: () => null } as unknown as import('../../../../src/server/runtime/types.js').ServerQueueManager; }

function deleteHandler(row: { kind: string; created_by_user_id: string | null } | null) {
  const { app, registered } = makeFakeApp();
  const routes = new ServerV1PostgresRoutes({ pool: makePool(row), queueManager: makeQueue() } as any);
  routes.setupRoutes(app as any);
  const reg = registered.find(r => r.method === 'delete' && r.path === '/v1/memories/:id')!;
  return reg.chain[reg.chain.length - 1]; // the async handler is last
}

function invoke(handler: RequestHandler, authContext: unknown) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { params: { id: 'obs1' }, authContext, requestId: 't' };
    const res: any = {
      statusCode: 0, body: null,
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; resolve({ status: this.statusCode || 200, body: b }); return this; },
    };
    Promise.resolve((handler as any)(req, res, () => {}));
  });
}

const ctx = (role: unknown, userId: string | null, teamId = 'team1') => ({ role, userId, teamId, projectId: null });

describe('DELETE /v1/memories/:id ownership rule', () => {
  it('member deleting own note → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u1' }), ctx('member', 'u1'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
  it('member deleting a generated observation → 403 wrong_kind', async () => {
    const res = await invoke(deleteHandler({ kind: 'observation', created_by_user_id: 'u1' }), ctx('member', 'u1'));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/generated observation requires admin/);
  });
  it("member deleting another's note → 403 wrong_owner", async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u2' }), ctx('member', 'u1'));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/belongs to another member/);
  });
  it('admin deleting a member note → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u2' }), ctx('admin', 'a1'));
    expect(res.status).toBe(200);
  });
  it('null-role legacy key deleting anything → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'observation', created_by_user_id: null }), ctx(null, null));
    expect(res.status).toBe(200);
  });
  it('nonexistent row → 404', async () => {
    const res = await invoke(deleteHandler(null), ctx('member', 'u1'));
    expect(res.status).toBe(404);
  });
});
