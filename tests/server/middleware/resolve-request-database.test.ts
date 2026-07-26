import { describe, it, expect } from 'bun:test';
import { resolveRequestDatabase } from '../../../src/server/middleware/resolve-request-database.js';
import { projectDatabaseName } from '../../../src/server/runtime/resolve-project-database.js';

const BASE_PROJECT_ID = 'base-proj';
const BASE_DB_NAME = 'postgres';

function fakeRegistry(overrides: { getPool?: (databaseName: string, ids: unknown) => Promise<unknown> } = {}) {
  const calls: Array<{ databaseName: string; ids: unknown }> = [];
  const pools = new Map<string, unknown>();
  const defaultGetPool = async (databaseName: string, ids: unknown) => {
    calls.push({ databaseName, ids });
    let pool = pools.get(databaseName);
    if (!pool) {
      pool = { __db: databaseName };
      pools.set(databaseName, pool);
    }
    return pool;
  };
  const registry: any = {
    getPool: overrides.getPool
      ? (databaseName: string, ids: unknown) => {
          calls.push({ databaseName, ids });
          return overrides.getPool!(databaseName, ids);
        }
      : defaultGetPool,
  };
  return { registry, calls };
}

function mockRes() {
  const r: any = {
    statusCode: 0,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return r;
}

function opts() {
  return { baseDatabaseName: BASE_DB_NAME, baseProjectId: BASE_PROJECT_ID };
}

describe('resolveRequestDatabase', () => {
  it('routes the base project id to the base database', async () => {
    const { registry, calls } = fakeRegistry();
    const middleware = resolveRequestDatabase(registry, opts());
    const req: any = { authContext: { projectId: BASE_PROJECT_ID, teamId: 't1' }, query: {}, body: {} };
    const res = mockRes();
    let nexted = false;
    await middleware(req, res, () => { nexted = true; });

    expect(calls).toHaveLength(1);
    expect(calls[0].databaseName).toBe(BASE_DB_NAME);
    expect(req.databasePool).toBeDefined();
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('routes a non-base project id to projectDatabaseName(id)', async () => {
    const { registry, calls } = fakeRegistry();
    const middleware = resolveRequestDatabase(registry, opts());
    const req: any = { authContext: { projectId: 'p2', teamId: 't1' }, query: {}, body: {} };
    const res = mockRes();
    let nexted = false;
    await middleware(req, res, () => { nexted = true; });

    expect(calls).toHaveLength(1);
    expect(calls[0].databaseName).toBe(projectDatabaseName('p2'));
    expect(req.databasePool).toBeDefined();
    expect(nexted).toBe(true);
  });

  it('responds 400 and does not consult the registry when authContext.projectId is missing', async () => {
    const { registry, calls } = fakeRegistry();
    const middleware = resolveRequestDatabase(registry, opts());
    const req: any = { authContext: { projectId: null, teamId: 't1' }, query: {}, body: {} };
    const res = mockRes();
    let nexted = false;
    await middleware(req, res, () => { nexted = true; });

    expect(calls).toHaveLength(0);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(req.databasePool).toBeUndefined();
  });

  it('SECURITY: ignores req.query.projectId and req.body.projectId; routes on authContext only', async () => {
    const { registry, calls } = fakeRegistry();
    const middleware = resolveRequestDatabase(registry, opts());
    const req: any = {
      authContext: { projectId: 'A', teamId: 't1' },
      query: { projectId: 'B' },
      body: { projectId: 'B' },
    };
    const res = mockRes();
    let nexted = false;
    await middleware(req, res, () => { nexted = true; });

    expect(calls).toHaveLength(1);
    expect(calls[0].databaseName).toBe(projectDatabaseName('A'));
    expect(calls[0].databaseName).not.toBe(projectDatabaseName('B'));
    expect(nexted).toBe(true);
  });

  it('responds 500 and does not call next() with a pool when registry.getPool rejects', async () => {
    const { registry } = fakeRegistry({ getPool: async () => { throw new Error('provision failed'); } });
    const middleware = resolveRequestDatabase(registry, opts());
    const req: any = { authContext: { projectId: 'p2', teamId: 't1' }, query: {}, body: {} };
    const res = mockRes();
    let nexted = false;
    await middleware(req, res, () => { nexted = true; });

    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(req.databasePool).toBeUndefined();
  });
});
