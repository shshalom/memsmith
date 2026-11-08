// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
} from '../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../src/storage/postgres/observations.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { newApiKey, createIsolatedSchema, dropSchema, TEST_POOL_MAX } from '../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('actor tags over the /v1 routes', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schemaName: string;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
  const ids: Record<string, string> = {};
  let spies: ReturnType<typeof spyOn>[] = [];
  let previousHybrid: string | undefined;

  beforeAll(async () => {
    previousHybrid = process.env.MEMSMITH_SEARCH_HYBRID;
    process.env.MEMSMITH_SEARCH_HYBRID = '0';
    spies = (['info', 'warn', 'error', 'debug'] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_actor_filter');
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: TEST_POOL_MAX, options: `-c search_path=${schemaName}` });
    await bootstrapServerPostgresSchema(pool);
    const client = await pool.connect() as PostgresPoolClient;
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({ keyHash: hash, teamId, projectId, actorId: 'test', scopes: ['memories:read', 'memories:write'] });
    client.release();

    const repo = new PostgresObservationRepository(pool);
    const seed = async (name: string, metadata: Record<string, unknown>) => {
      ids[name] = (await repo.create({ projectId, teamId, kind: 'discovery', content: `Queue engine finding ${name}`, metadata })).id;
    };
    await seed('reviewer', { actor: 'reviewer' });
    await seed('both', { actors: ['reviewer', 'Explore'] });
    await seed('explore', { actor: 'Explore', actors: ['Explore'] });
    await seed('legacy', {});

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    const queue = () => ({ async add() {}, async getJob() { return null; }, async remove() {} }) as never;
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled in tests'),
      authMode: 'api-key',
      getEventQueue: queue,
      getSummaryQueue: queue,
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const address = server.getHttpServer()?.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    port = address.port;
  });

  afterAll(async () => {
    try { await server.close(); } catch { /* already closed */ }
    await pool.end();
    await dropSchema(testDatabaseUrl!, schemaName);
    spies.forEach((spy) => spy.mockRestore());
    if (previousHybrid === undefined) delete process.env.MEMSMITH_SEARCH_HYBRID;
    else process.env.MEMSMITH_SEARCH_HYBRID = previousHybrid;
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKeyRaw}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function idsFrom(path: string, body: Record<string, unknown>): Promise<string[]> {
    const res = await post(path, { projectId, ...body });
    expect(res.status).toBe(200);
    const json = await res.json() as { observations: Array<{ id: string }> };
    return json.observations.map((o) => o.id).sort();
  }

  it('/v1/search returns only records whose actor matches or whose actors include it', async () => {
    expect(await idsFrom('/v1/search', { query: 'queue engine', actor: 'reviewer' })).toEqual([ids.reviewer, ids.both].sort());
    expect(await idsFrom('/v1/search', { query: 'queue engine', actor: 'Explore' })).toEqual([ids.both, ids.explore].sort());
  });

  it('/v1/search without an actor still returns records that have none', async () => {
    expect(await idsFrom('/v1/search', { query: 'queue engine' })).toContain(ids.legacy);
  });

  it('/v1/search lists recent records for an actor when the query is empty', async () => {
    expect(await idsFrom('/v1/search', { query: '', actor: 'reviewer' })).toEqual([ids.reviewer, ids.both].sort());
  });

  it('matches the actor exactly, not by prefix or case', async () => {
    expect(await idsFrom('/v1/search', { query: 'queue engine', actor: 'review' })).toEqual([]);
    expect(await idsFrom('/v1/search', { query: 'queue engine', actor: 'REVIEWER' })).toEqual([]);
  });

  it('/v1/context applies the same filter', async () => {
    expect(await idsFrom('/v1/context', { query: 'queue engine', actor: 'Explore' })).toEqual([ids.both, ids.explore].sort());
  });

  it('rejects an actor filter with control characters', async () => {
    const res = await post('/v1/search', { projectId, query: 'queue', actor: 'bad\nactor' });
    expect(res.status).toBe(400);
  });

  it('the hosted /v1/mcp search tool applies the actor filter', async () => {
    const mcp = new Client({ name: 'actor-test', version: '0' }, { capabilities: {} });
    await mcp.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/v1/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${apiKeyRaw}` } } },
    ));
    try {
      const result = await mcp.callTool({ name: 'search', arguments: { projectId, query: 'queue engine', actor: 'Explore' } });
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(text).toContain(`[${ids.explore}]`);
      expect(text).toContain(`[${ids.both}]`);
      expect(text).not.toContain(`[${ids.reviewer}]`);
      expect(text).not.toContain(`[${ids.legacy}]`);
    } finally {
      await mcp.close();
    }
  });

  it('rejects a blank actor filter, like the CLI', async () => {
    const res = await post('/v1/search', { projectId, query: 'queue', actor: '   ' });
    expect(res.status).toBe(400);
  });

  describe('when a matching record is superseded by another actor', () => {
    let oldId: string;
    let headId: string;
    beforeAll(async () => {
      const repo = new PostgresObservationRepository(pool);
      oldId = (await repo.create({ projectId, teamId, kind: 'decision', content: 'Zorbaxian retry budget is three', metadata: { actor: 'reviewer' } })).id;
      headId = (await repo.create({ projectId, teamId, kind: 'decision', content: 'Retry budget raised to five', metadata: { actor: 'Explore' }, supersedes: oldId })).id;
    });

    it('/v1/search keeps the matching record, marked superseded, and hides the other actor\'s head', async () => {
      const res = await post('/v1/search', { projectId, query: 'zorbaxian', actor: 'reviewer' });
      const { observations } = await res.json() as { observations: Array<{ id: string; supersededBy?: string }> };
      expect(observations.map((o) => o.id)).toEqual([oldId]);
      expect(observations[0].supersededBy).toBe(headId);
    });

    it('/v1/context returns nothing, because it serves only the current head', async () => {
      expect(await idsFrom('/v1/context', { query: 'zorbaxian', actor: 'reviewer' })).toEqual([]);
    });
  });
});
