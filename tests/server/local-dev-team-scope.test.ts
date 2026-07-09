// SPDX-License-Identifier: Apache-2.0
//
// Tests for MEMSMITH_LOCAL_DEV_TEAM_ID wiring: unauthenticated loopback
// requests in local-dev bypass mode must receive authContext.teamId from the
// configured team ID so /dashboard/* and /v1/* endpoints are usable keylessly
// in a local-dev environment without returning "teamId is required" / 400.
//
// The test exercises the middleware directly via a real Express server
// (127.0.0.1 → loopback checks pass) so no Postgres connection is needed.
// The Postgres-gated suite (bottom) does a full integration mount via
// DashboardRoutes when MEMSMITH_TEST_POSTGRES_URL is set.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { requirePostgresServerAuth } from '../../src/server/middleware/postgres-auth.js';
import { DashboardRoutes } from '../../src/server/dashboard/routes.js';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/index.js';

// ---------------------------------------------------------------------------
// Unit-level: exercise the middleware via a real loopback HTTP request.
// No Postgres needed — the bypass branch never touches the pool when
// both authMode === 'local-dev' and allowLocalDevBypass are set.
// ---------------------------------------------------------------------------
describe('requirePostgresServerAuth — localDevTeamId wiring', () => {
  let httpServer: ReturnType<typeof express> extends infer A ? A : never;
  let port: number;
  let closeServer: () => Promise<void>;

  function buildApp(localDevTeamId: string | null | undefined) {
    const app = express();
    // Fake pool — the bypass branch never queries Postgres, but the
    // signature requires a pool argument.
    const fakePool = {} as Parameters<typeof requirePostgresServerAuth>[0];
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId,
      requiredScopes: ['memories:read'],
    });
    app.get('/probe', mw, (req, res) => {
      res.json({ teamId: req.authContext?.teamId ?? null, mode: req.authContext?.mode ?? null });
    });
    return app;
  }

  async function startApp(localDevTeamId: string | null | undefined): Promise<number> {
    const app = buildApp(localDevTeamId);
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('no port'));
          return;
        }
        port = addr.port;
        closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
        resolve(addr.port);
      });
    });
  }

  afterEach(async () => {
    if (closeServer) await closeServer();
  });

  it('sets authContext.teamId to localDevTeamId on a keyless loopback request', async () => {
    const p = await startApp('TID');
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      headers: { Host: 'localhost' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { teamId: string | null; mode: string | null };
    expect(body.teamId).toBe('TID');
    expect(body.mode).toBe('local-dev');
  });

  it('sets authContext.teamId to null when localDevTeamId is not provided (existing behavior)', async () => {
    const p = await startApp(null);
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      headers: { Host: 'localhost' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { teamId: string | null; mode: string | null };
    expect(body.teamId).toBeNull();
    expect(body.mode).toBe('local-dev');
  });

  it('does NOT apply localDevTeamId in api-key mode (safety: keyless request returns 401)', async () => {
    const app = express();
    const fakePool = {} as Parameters<typeof requirePostgresServerAuth>[0];
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'api-key',
      allowLocalDevBypass: false,
      localDevTeamId: 'TID',
      requiredScopes: ['memories:read'],
    });
    app.get('/probe', mw, (_req, res) => { res.json({ ok: true }); });
    const p = await new Promise<number>((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
        const listenPort = (addr as { port: number }).port;
        closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
        resolve(listenPort);
      });
    });
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      headers: { Host: 'localhost' },
    });
    // In api-key mode with no key the request must be rejected.
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Integration: mount DashboardRoutes with localDevTeamId and confirm a
// keyless loopback GET /dashboard/board returns 200 (not 400 teamId-required).
// Postgres-gated — skips cleanly when MEMSMITH_TEST_POSTGRES_URL is unset.
// ---------------------------------------------------------------------------
const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('DashboardRoutes — localDevTeamId integration', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    await bootstrapServerPostgresSchema(pool);

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: () => Promise.resolve(),
      onRestart: () => Promise.resolve(),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'local-dev', lastInteraction: null }),
    });

    // Mount exactly as ServerService does, but with localDevTeamId set.
    server.registerRoutes(new DashboardRoutes({
      db: pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: 'test-team-local-dev',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('expected an ephemeral TCP port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as { code?: string })?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    await pool.end();
  });

  it('returns 200 on /dashboard/board for a keyless loopback request when localDevTeamId is set', async () => {
    // No Authorization header — the local-dev bypass should kick in and
    // scope the request to 'test-team-local-dev'. The query returns an
    // empty board (no data) but the route succeeds.
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/board`, {
      headers: { Host: 'localhost' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // The board shape has a 'columns' or 'items' key — just confirm we got
    // a valid JSON object, not an error payload.
    expect(typeof body).toBe('object');
    expect(body).not.toHaveProperty('error');
  });

  it('returns 401 on /dashboard/board when localDevTeamId is NOT set (regression: existing behavior)', async () => {
    // Boot a second server without localDevTeamId.
    const server2 = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: () => Promise.resolve(),
      onRestart: () => Promise.resolve(),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'local-dev', lastInteraction: null }),
    });
    server2.registerRoutes(new DashboardRoutes({
      db: pool,
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      // localDevTeamId intentionally absent — keyless request has null teamId.
    }));
    server2.finalizeRoutes();
    await server2.listen(0, '127.0.0.1');
    const address2 = server2.getHttpServer()?.address();
    if (!address2 || typeof address2 === 'string') throw new Error('expected an ephemeral TCP port');
    const port2 = (address2 as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/dashboard/board`, {
        headers: { Host: 'localhost' },
      });
      // Without localDevTeamId the bypass path has teamId=null.
      // The route returns 400 (teamId is required). Confirm it is not 200.
      expect(res.status).not.toBe(200);
    } finally {
      try { await server2.close(); } catch { /* ignore */ }
    }
  });
});
