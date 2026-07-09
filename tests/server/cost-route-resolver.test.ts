// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import express from 'express';
import { registerDashboardRoutes } from '../../src/server/dashboard/routes.js';

// Assert the cost route forwards a resolver so the rate/provider come from settings.
describe('dashboard cost route forwards resolver to costPanel', () => {
  it('uses resolver-provided provider (localGeneration reflects it)', async () => {
    const fakeDb = { query: async () => ({ rows: [{ saved: '0', pre: '0', discovery_tokens: '0' }] }) } as any;
    const resolver = { inputRatePerMtok: async () => 7, provider: async () => 'claude' } as any;
    const app = express();
    app.use((req: any, _res, next) => { req.authContext = { teamId: 'team-x' }; next(); });
    registerDashboardRoutes(app, fakeDb, [], resolver);
    const server = app.listen(0, '127.0.0.1');
    try {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/dashboard/cost?teamId=team-x`);
      const body = await res.json();
      expect(body.localGeneration).toBe(false); // claude -> not local
    } finally { server.close(); }
  });
});
