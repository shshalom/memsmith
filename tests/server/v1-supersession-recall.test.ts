// SPDX-License-Identifier: Apache-2.0
//
// Task 2: Supersession-chain read — /v1/context collapses superseded hits to
// their heads; /v1/search annotates them with supersededBy and appends the head.
//
// Postgres-gated: requires CLAUDE_MEM_TEST_POSTGRES_URL.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../src/storage/postgres/observations.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { quoteIdentifier, newApiKey, createIsolatedSchema, dropSchema, TEST_POOL_MAX } from '../sdk/pg-isolation.js';
import * as supersessionModule from '../../src/server/retrieval/supersession.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

describe('supersession-chain recall: /v1/context collapse and /v1/search annotate', () => {
  if (!testDatabaseUrl) {
    it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;
  let teamId: string;
  let projectId: string;
  let apiKeyRaw: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
    ];

    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_supersession_recall');
    pool = new pg.Pool({
      connectionString: testDatabaseUrl,
      max: TEST_POOL_MAX,
      options: `-c search_path=${schemaName}`,
    });
    await bootstrapServerPostgresSchema(pool);

    // Use a dedicated client for storage setup (teams, projects, auth).
    const client = await pool.connect() as PostgresPoolClient;
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;

    const { raw, hash } = newApiKey();
    apiKeyRaw = raw;
    await storage.auth.createApiKey({
      keyHash: hash,
      teamId,
      projectId,
      actorId: 'test',
      scopes: ['memories:read', 'memories:write'],
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

  // Force plain FTS so tests are stable (no embedder in CI).
  const withFts = (fn: () => Promise<void>) => async () => {
    const prev = process.env.CLAUDE_MEM_SEARCH_HYBRID;
    process.env.CLAUDE_MEM_SEARCH_HYBRID = '0';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.CLAUDE_MEM_SEARCH_HYBRID;
      else process.env.CLAUDE_MEM_SEARCH_HYBRID = prev;
    }
  };

  async function authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${apiKeyRaw}`, 'Content-Type': 'application/json' };
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
  }

  /**
   * Seed a superseded chain: insert `old` obs with unique query terms,
   * then insert `head` obs (without those terms) that supersedes `old`.
   * Only a search for the old terms should surface `old` (and therefore
   * trigger supersession resolution).
   *
   * Returns { oldId, headId }.
   */
  async function seedChain(uniqueTerm: string): Promise<{ oldId: string; headId: string }> {
    const repo = new PostgresObservationRepository(pool);
    const old = await repo.create({
      projectId,
      teamId,
      content: `Zorbax ${uniqueTerm} migration notes from old architecture`,
      kind: 'manual',
    });
    const head = await repo.create({
      projectId,
      teamId,
      content: `Updated architecture design document for new system`,
      kind: 'manual',
      supersedes: old.id,
    });
    return { oldId: old.id, headId: head.id };
  }

  it('/v1/context collapses a superseded hit to its head (old id absent, head id present)', withFts(async () => {
    const { oldId, headId } = await seedChain('xyzblorgzap');

    const res = await postJson('/v1/context', { projectId, query: 'xyzblorgzap', limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ id: string }> };
    const ids = body.observations.map(o => o.id);

    // Old id must be replaced by head; old must not appear.
    expect(ids).toContain(headId);
    expect(ids).not.toContain(oldId);
  }));

  it('/v1/search annotates the superseded hit with supersededBy=headId AND head is present', withFts(async () => {
    const { oldId, headId } = await seedChain('frobnicator99');

    const res = await postJson('/v1/search', { projectId, query: 'frobnicator99', limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ id: string; supersededBy?: string }> };
    const ids = body.observations.map(o => o.id);

    // Old hit must be present with supersededBy annotation.
    const oldHit = body.observations.find(o => o.id === oldId);
    expect(oldHit).toBeDefined();
    expect(oldHit?.supersededBy).toBe(headId);

    // Head must also be present (appended).
    expect(ids).toContain(headId);
  }));

  it('dedupe: head already in ranked results appears exactly once in /v1/search', withFts(async () => {
    // Seed the chain with unique terms that BOTH old AND head share, so both
    // come back from FTS — head must appear only once after deduplication.
    const repo = new PostgresObservationRepository(pool);
    const uniqueWord = 'quuxfrobnitz';
    const old = await repo.create({
      projectId,
      teamId,
      content: `${uniqueWord} old subsystem notes`,
      kind: 'manual',
    });
    const head = await repo.create({
      projectId,
      teamId,
      content: `${uniqueWord} updated subsystem notes`,
      kind: 'manual',
      supersedes: old.id,
    });

    const res = await postJson('/v1/search', { projectId, query: uniqueWord, limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ id: string }> };
    const ids = body.observations.map(o => o.id);

    // Head must appear exactly once.
    expect(ids.filter(id => id === head.id)).toHaveLength(1);
    // Old hit should be present with annotation.
    expect(ids).toContain(old.id);
  }));

  it('dedupe: head already in ranked results appears exactly once in /v1/context', withFts(async () => {
    const repo = new PostgresObservationRepository(pool);
    const uniqueWord = 'blorpenstein';
    const old = await repo.create({
      projectId,
      teamId,
      content: `${uniqueWord} old subsystem notes`,
      kind: 'manual',
    });
    const head = await repo.create({
      projectId,
      teamId,
      content: `${uniqueWord} updated subsystem notes`,
      kind: 'manual',
      supersedes: old.id,
    });

    const res = await postJson('/v1/context', { projectId, query: uniqueWord, limit: 10 });
    expect(res.status).toBe(200);
    const body = await res.json() as { observations: Array<{ id: string }> };
    const ids = body.observations.map(o => o.id);

    // Head must appear exactly once (deduped even though old resolved to same head).
    expect(ids.filter(id => id === head.id)).toHaveLength(1);
    // Old hit must be absent (collapsed to head).
    expect(ids).not.toContain(old.id);
  }));

  it('degrade-on-error: returns ranked results unchanged (no 500) when supersession resolution throws', withFts(async () => {
    const repo = new PostgresObservationRepository(pool);
    const uniqueWord = 'snorbletux';
    const obs = await repo.create({
      projectId,
      teamId,
      content: `${uniqueWord} critical system decision`,
      kind: 'manual',
    });

    // Spy on resolveHeads to force it to throw.
    const spy = spyOn(supersessionModule, 'resolveHeads').mockRejectedValue(new Error('db exploded'));
    try {
      const res = await postJson('/v1/search', { projectId, query: uniqueWord, limit: 10 });
      expect(res.status).toBe(200);
      const body = await res.json() as { observations: Array<{ id: string; supersededBy?: string }> };
      const ids = body.observations.map(o => o.id);

      // The original hit must be present — unmodified, no 500.
      expect(ids).toContain(obs.id);
      // No supersededBy annotation on a non-superseded obs.
      const hit = body.observations.find(o => o.id === obs.id);
      expect(hit?.supersededBy).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  }));
});
