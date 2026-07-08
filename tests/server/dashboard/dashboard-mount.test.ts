// SPDX-License-Identifier: Apache-2.0
//
// Runtime-mount test for the team dashboard. The dashboard route handlers are
// unit-tested in routes.test.ts, but nothing verified that the SERVER actually
// mounts them — the module was dormant (built, never registered). This test
// mounts DashboardRoutes exactly as ServerService does (Postgres pool +
// api-key auth) and asserts the routes are reachable and auth-gated.
//
// Postgres-gated: skips cleanly when MEMSMITH_TEST_POSTGRES_URL is unset.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { DashboardRoutes } from '../../../src/server/dashboard/routes.js';
import { bootstrapServerPostgresSchema } from '../../../src/storage/postgres/index.js';
import { logger } from '../../../src/utils/logger.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('dashboard runtime mount', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }

  let pool: pg.Pool;
  let server: Server;
  let port: number;
  let spies: Array<{ mockRestore: () => void }>;

  beforeEach(async () => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await bootstrapServerPostgresSchema(pool);

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: () => Promise.resolve(),
      onRestart: () => Promise.resolve(),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    });
    // Mount the dashboard the same way ServerService.start() does.
    server.registerRoutes(new DashboardRoutes({ db: pool, authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('expected an ephemeral TCP port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: any) { if (e?.code !== 'ERR_SERVER_NOT_RUNNING') throw e; }
    await pool.end();
    spies.forEach(s => s.mockRestore());
  });

  it('serves the dashboard UI (handler mounted, not 404)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('enforces auth on a data route (401 without a key)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/board?teamId=t`);
    expect(res.status).toBe(401);
  });
});
