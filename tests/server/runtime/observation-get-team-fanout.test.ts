// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/observations/get must reach every project database in the caller's
// team, as /v1/search does: an id that search returned from a teammate's
// project has to be fetchable.
//
// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL with rights to create databases.

import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { projectDatabaseName } from '../../../src/server/runtime/resolve-project-database.js';
import { ServerClient } from '../../../src/services/hooks/server-client.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

function urlFor(database: string): string {
  const url = new URL(testDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

describe('POST /v1/observations/get across a team', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let basePool: pg.Pool;
  let siblingPool: pg.Pool;
  let siblingDb: string;
  let server: Server;
  let client: ServerClient;
  let projectId: string;
  let ownId: string;
  let siblingId: string;
  let supersededId: string;
  const spies: ReturnType<typeof spyOn>[] = [];

  beforeAll(async () => {
    for (const level of ['info', 'warn', 'error', 'debug'] as const) spies.push(spyOn(logger, level).mockImplementation(() => {}));
    const schema = `cm_get_fanout_${crypto.randomUUID().replace(/-/g, '_')}`;
    basePool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    basePool.on('connect', c => { c.query(`SET search_path TO ${quoteIdentifier(schema)}`).catch(() => {}); });
    const setup = await basePool.connect();
    await setup.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await setup.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    await bootstrapServerPostgresSchema(setup);
    const storage = createPostgresStorageRepositories(setup);
    const team = await storage.teams.create({ name: 'team' });
    const own = await storage.projects.create({ teamId: team.id, name: 'own' });
    const sibling = await storage.projects.create({ teamId: team.id, name: 'sibling' });
    projectId = own.id;
    const { raw, hash } = newApiKey();
    await storage.auth.createApiKey({ keyHash: hash, teamId: team.id, projectId: own.id, actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    const ownRepo = new PostgresObservationRepository(setup);
    const older = await ownRepo.create({ projectId, teamId: team.id, content: 'Old decision', kind: 'decision' });
    supersededId = older.id;
    await ownRepo.create({ projectId, teamId: team.id, content: 'New decision', kind: 'decision', supersedes: older.id });
    ownId = (await ownRepo.create({ projectId, teamId: team.id, content: 'Own row', kind: 'manual' })).id;
    setup.release();

    siblingDb = projectDatabaseName(sibling.id);
    await basePool.query(`CREATE DATABASE ${quoteIdentifier(siblingDb)}`);
    siblingPool = new pg.Pool({ connectionString: urlFor(siblingDb), max: 2 });
    await siblingPool.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
    const siblingClient = await siblingPool.connect();
    await bootstrapServerPostgresSchema(siblingClient);
    await siblingClient.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [team.id, 'team']);
    await siblingClient.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3)', [sibling.id, team.id, 'sibling']);
    siblingId = (await new PostgresObservationRepository(siblingClient).create({
      projectId: sibling.id, teamId: team.id, content: 'Teammate row in the sibling database', kind: 'manual',
    })).id;
    siblingClient.release();

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
      pool: basePool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      baseProjectId: projectId,
      baseDatabaseName: 'postgres',
      poolRegistry: {
        getPool: async (database: string) => {
          if (database === 'postgres') return basePool;
          if (database === siblingDb) return siblingPool;
          throw new Error(`unexpected database ${database}`);
        },
        closeAll: async () => {},
      } as never,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    client = new ServerClient({ serverBaseUrl: `http://127.0.0.1:${address.port}`, apiKey: raw });
  }, 60_000);

  afterAll(async () => {
    try { await server?.close(); } catch { /* already closed */ }
    await siblingPool?.end();
    if (siblingDb) await basePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(siblingDb)} WITH (FORCE)`);
    await basePool?.end();
    spies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it('returns rows from the caller project and from a sibling project database', async () => {
    const result = await client.getObservations({ projectId, ids: [ownId, siblingId] });
    expect(result.observations.map(o => o.id).sort()).toEqual([ownId, siblingId].sort());
  });

  it('marks a requested row that a newer observation superseded', async () => {
    const result = await client.getObservations({ projectId, ids: [supersededId] });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.supersededBy).toBeTruthy();
    expect(result.observations[0]?.supersededBy).not.toBe(supersededId);
  });
});
