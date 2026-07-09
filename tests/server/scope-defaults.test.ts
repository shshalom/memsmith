// SPDX-License-Identifier: Apache-2.0
//
// Task 7.5: scope-defaults — /v1/search, /v1/context, and /dashboard/*
// default scope from req.authContext when the client omits projectId/teamId.
//
// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { DashboardRoutes } from '../../src/server/dashboard/routes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../src/storage/postgres/observations.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, dropSchema, TEST_POOL_MAX } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('scope-defaults: server resolves projectId/teamId from auth key when client omits them', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  // Scoped key: carries teamId + projectId in authContext
  let scopedKeyRaw: string;
  // Team-only key: carries teamId but no projectId (dashboard tests)
  let teamKeyRaw: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  // Force plain FTS so tests are stable (no embedder in CI).
  const withFts = (fn: () => Promise<void>) => async () => {
    const prev = process.env.MEMSMITH_SEARCH_HYBRID;
    process.env.MEMSMITH_SEARCH_HYBRID = '0';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.MEMSMITH_SEARCH_HYBRID;
      else process.env.MEMSMITH_SEARCH_HYBRID = prev;
    }
  };

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];

    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_scope_defaults');
    pool = new pg.Pool({
      connectionString: testDatabaseUrl,
      max: TEST_POOL_MAX,
      options: `-c search_path=${schemaName}`,
    });
    await bootstrapServerPostgresSchema(pool);

    const client = await pool.connect() as PostgresPoolClient;
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'scope-defaults-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'scope-defaults-project' });
    teamId = team.id;
    projectId = project.id;

    // Scoped key: bound to both teamId and projectId.
    const scoped = newApiKey();
    scopedKeyRaw = scoped.raw;
    await storage.auth.createApiKey({
      keyHash: scoped.hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
    });

    // Team-only key: bound to teamId only (no projectId).
    const team2 = newApiKey();
    teamKeyRaw = team2.raw;
    await storage.auth.createApiKey({
      keyHash: team2.hash,
      teamId,
      projectId: null,
      actorId: 'test',
      scopes: ['memories:read'],
    });

    client.release();

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      getEventQueue: () => ({
        async add() {},
        async getJob() { return null; },
        async remove() {},
      }) as never,
      getSummaryQueue: () => ({
        async add() {},
        async getJob() { return null; },
        async remove() {},
      }) as never,
    }));
    server.registerRoutes(new DashboardRoutes({ db: pool, authMode: 'api-key' }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') throw error;
    }
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function postJson(path: string, body: unknown, key: string = scopedKeyRaw): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  function getJson(path: string, key: string = scopedKeyRaw): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  }

  async function seedObservation(content: string): Promise<string> {
    const repo = new PostgresObservationRepository(pool);
    const obs = await repo.create({ projectId, teamId, content, kind: 'manual' });
    return obs.id;
  }

  // -------------------------------------------------------------------
  // /v1/search
  // -------------------------------------------------------------------

  describe('/v1/search', () => {
    it('(regression) WITH projectId in body — works as before', withFts(async () => {
      const id = await seedObservation('zorblax regression test content unique');
      const res = await postJson('/v1/search', { projectId, query: 'zorblax regression' });
      expect(res.status).toBe(200);
      const body = await res.json() as { observations: Array<{ id: string }> };
      expect(body.observations.map(o => o.id)).toContain(id);
    }));

    it('WITHOUT projectId, scoped key carries projectId → uses authContext projectId', withFts(async () => {
      const id = await seedObservation('quorblax scope-default test content unique');
      // No projectId in body — server must infer it from the key's authContext.
      const res = await postJson('/v1/search', { query: 'quorblax scope-default' });
      expect(res.status).toBe(200);
      const body = await res.json() as { observations: Array<{ id: string }> };
      expect(body.observations.map(o => o.id)).toContain(id);
    }));

    it('WITHOUT projectId AND key has no projectId → 400 with clear message', withFts(async () => {
      // teamKeyRaw is bound to teamId only; its authContext.projectId is null.
      const res = await postJson('/v1/search', { query: 'anything' }, teamKeyRaw);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('ValidationError');
      expect(body.message).toContain('projectId required');
    }));
  });

  // -------------------------------------------------------------------
  // /v1/context
  // -------------------------------------------------------------------

  describe('/v1/context', () => {
    it('(regression) WITH projectId in body — works as before', withFts(async () => {
      await seedObservation('frobnitz context regression content unique');
      const res = await postJson('/v1/context', { projectId, query: 'frobnitz context regression' });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string };
      expect(body.context).toContain('frobnitz');
    }));

    it('WITHOUT projectId, scoped key carries projectId → uses authContext projectId', withFts(async () => {
      await seedObservation('blorpzax context scope default content unique');
      const res = await postJson('/v1/context', { query: 'blorpzax context scope' });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string };
      expect(body.context).toContain('blorpzax');
    }));

    it('WITHOUT projectId AND key has no projectId → 400 with clear message', withFts(async () => {
      const res = await postJson('/v1/context', { query: 'anything' }, teamKeyRaw);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('ValidationError');
      expect(body.message).toContain('projectId required');
    }));
  });

  // -------------------------------------------------------------------
  // /dashboard/board
  // -------------------------------------------------------------------

  describe('/dashboard/board', () => {
    it('WITHOUT ?teamId, key carries teamId → returns board (scoped from key)', async () => {
      // teamKeyRaw is bound to the same teamId as the project.
      const res = await getJson('/dashboard/board', teamKeyRaw);
      expect(res.status).toBe(200);
    });

    it('(regression) WITH ?teamId → still honored', async () => {
      const res = await getJson(`/dashboard/board?teamId=${teamId}`, teamKeyRaw);
      expect(res.status).toBe(200);
    });

    it('no ?teamId AND key has no teamId → 400', async () => {
      // Create a key with no teamId and no projectId.
      const client = await pool.connect() as PostgresPoolClient;
      const s = createPostgresStorageRepositories(client);
      const noTeamKey = newApiKey();
      await s.auth.createApiKey({
        keyHash: noTeamKey.hash,
        teamId: null,
        projectId: null,
        actorId: 'test',
        scopes: ['memories:read'],
      });
      client.release();

      const res = await getJson('/dashboard/board', noTeamKey.raw);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe('ValidationError');
    });
  });
});
