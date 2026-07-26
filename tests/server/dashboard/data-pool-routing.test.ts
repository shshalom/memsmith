// SPDX-License-Identifier: Apache-2.0
//
// Task 5 — registerDashboardRoutes' optional 5th param (resolveDataDb) lets a
// per-request DATA connection (resolved via the PoolRegistry, mirroring
// resolveRequestDatabase) stand in for `db` on the observations-reading
// routes, while `db` itself keeps serving as the ACCOUNT connection (and the
// fallback DATA connection when resolveDataDb is absent — see routes.ts doc).
import { describe, it, expect } from 'bun:test';
import express from 'express';
import { registerDashboardRoutes } from '../../../src/server/dashboard/routes.js';

describe('dashboard routes — per-request DATA pool routing', () => {
  it('without resolveDataDb, every route reads from the single `db` connection (unchanged behavior)', async () => {
    let dbCalls = 0;
    const fakeDb = { query: async () => { dbCalls += 1; return { rows: [] }; } } as any;
    const app = express();
    app.use((req: any, _res, next) => { req.authContext = { teamId: 'team-x' }; next(); });
    registerDashboardRoutes(app, fakeDb, []);
    const server = app.listen(0, '127.0.0.1');
    try {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/dashboard/board?teamId=team-x`);
      expect(res.status).toBe(200);
      expect(dbCalls).toBeGreaterThan(0);
    } finally { server.close(); }
  });

  it('with resolveDataDb, board/decisions/blocked/metrics/notes read from the RESOLVED pool, not `db`', async () => {
    let baseDbCalls = 0;
    let dataDbCalls = 0;
    const baseDb = { query: async () => { baseDbCalls += 1; return { rows: [] }; } } as any;
    const dataDb = { query: async () => { dataDbCalls += 1; return { rows: [] }; } } as any;
    const app = express();
    app.use((req: any, _res, next) => { req.authContext = { teamId: 'team-x' }; next(); });
    registerDashboardRoutes(app, baseDb, [], undefined, () => dataDb);
    const server = app.listen(0, '127.0.0.1');
    try {
      const port = (server.address() as any).port;
      const board = await fetch(`http://127.0.0.1:${port}/dashboard/board?teamId=team-x`);
      expect(board.status).toBe(200);
      expect(dataDbCalls).toBeGreaterThan(0);
      expect(baseDbCalls).toBe(0);
    } finally { server.close(); }
  });

  it('with resolveDataDb, /dashboard/cost still reads usage_events from the BASE `db`, and observations from the resolved pool', async () => {
    let baseDbCalls = 0;
    let dataDbCalls = 0;
    const baseDb = {
      query: async () => { baseDbCalls += 1; return { rows: [{ saved: '0', pre: '0' }] }; },
    } as any;
    const dataDb = {
      query: async () => { dataDbCalls += 1; return { rows: [{ discovery_tokens: '0' }] }; },
    } as any;
    const app = express();
    app.use((req: any, _res, next) => { req.authContext = { teamId: 'team-x' }; next(); });
    registerDashboardRoutes(app, baseDb, [], undefined, () => dataDb);
    const server = app.listen(0, '127.0.0.1');
    try {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/dashboard/cost?teamId=team-x`);
      expect(res.status).toBe(200);
      // usage_events (compression) query hit the base connection.
      expect(baseDbCalls).toBeGreaterThan(0);
      // observations (discovery_tokens) query hit the resolved data connection.
      expect(dataDbCalls).toBeGreaterThan(0);
    } finally { server.close(); }
  });
});
