// SPDX-License-Identifier: Apache-2.0
//
// Phase 8 — verifies the new /v1/memories, /v1/search, /v1/context, and
// /v1/jobs/:id REST endpoints behave the way the MCP `observation_*` tools
// expect, and verifies the ServerClient (which the MCP tools use) hits
// those endpoints end-to-end.
//
// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { Server } from '../../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../../src/server/runtime/types.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { ServerClient } from '../../../src/services/hooks/server-client.js';
import { logger } from '../../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('Phase 8 MCP-backing REST endpoints (/v1/memories, /v1/search, /v1/context, /v1/jobs/:id)', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
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
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_phase8_routes_${crypto.randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (poolClient) => {
      poolClient.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {});
    });
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
      // Capture-only queue stub so /v1/events succeeds without BullMQ.
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
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function buildClient(): ServerClient {
    return new ServerClient({
      serverBaseUrl: `http://127.0.0.1:${port}`,
      apiKey: apiKeyRaw,
    });
  }

  it('observation_add path: POST /v1/memories inserts an observation without enqueuing generation', async () => {
    const c = buildClient();
    const before = await pool.query(`SELECT count(*)::int AS n FROM observation_generation_jobs`);
    const result = await c.addObservation({
      projectId,
      content: 'Manual observation about login bug',
      kind: 'manual',
      // facts/narrative are the structured fields the ingest quality gate
      // (task 3) scores; without them this manual insert would score below
      // the default floor of 20 and be rejected with 422.
      metadata: { tag: 'mcp', facts: ['Login bug reported by user'], narrative: 'A manual observation recorded about a login bug encountered in production.' },
    });
    expect(result.memory.id).toBeTruthy();
    expect(result.memory.projectId).toBe(projectId);
    expect(result.memory.content).toBe('Manual observation about login bug');

    const obsCount = await pool.query(`SELECT count(*)::int AS n FROM observations`);
    expect(obsCount.rows[0]?.n).toBe(1);

    // Anti-pattern guard: /v1/memories MUST NOT create a generation job.
    const after = await pool.query(`SELECT count(*)::int AS n FROM observation_generation_jobs`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('observation_record_event path: POST /v1/events creates event row + outbox row atomically', async () => {
    const c = buildClient();
    const result = await c.recordEvent({
      projectId,
      sourceType: 'api',
      eventType: 'mcp_test_event',
      occurredAtEpoch: Date.now(),
      payload: { hello: 'world' },
    });
    expect(result.event.id).toBeTruthy();

    const eventRows = await pool.query(`SELECT id, project_id FROM agent_events`);
    expect(eventRows.rows).toHaveLength(1);

    // The outbox row should exist because ?generate defaults to true.
    const jobRows = await pool.query(
      `SELECT id, source_type, status FROM observation_generation_jobs WHERE source_type = 'agent_event'`,
    );
    expect(jobRows.rows).toHaveLength(1);
    expect(jobRows.rows[0]?.status).toBe('queued');
  });

  it('observation_search path: POST /v1/search returns FTS-ranked observations from PostgresObservationRepository', async () => {
    // Seed two observations directly via REST so we exercise the same write path.
    const c = buildClient();
    // facts/narrative clear the task-3 ingest quality floor (score >= 20).
    await c.addObservation({ projectId, content: 'Refactored authentication middleware to use JWT verification', kind: 'manual', metadata: { facts: ['Switched middleware to JWT'], narrative: 'Refactored the authentication middleware layer to use JWT-based verification instead of sessions.' } });
    await c.addObservation({ projectId, content: 'Fixed flaky test in payment processing', kind: 'manual', metadata: { facts: ['Stabilized a flaky test'], narrative: 'Fixed a flaky test in the payment processing suite caused by a race condition.' } });

    const matches = await c.searchObservations({ projectId, query: 'authentication', limit: 10 });
    expect(matches.observations.length).toBeGreaterThanOrEqual(1);
    expect(matches.observations[0]?.content).toContain('authentication');

    const noMatches = await c.searchObservations({ projectId, query: 'nonexistent_xyz_term', limit: 10 });
    expect(noMatches.observations).toHaveLength(0);
  });

  it('observation_context path: POST /v1/context returns observations + concatenated context', async () => {
    const c = buildClient();
    // facts/narrative clear the task-3 ingest quality floor (score >= 20).
    await c.addObservation({ projectId, content: 'first observation about deployment pipeline', kind: 'manual', metadata: { facts: ['Deployment pipeline updated'], narrative: 'First observation describing a change to the deployment pipeline.' } });
    await c.addObservation({ projectId, content: 'second observation about deployment pipeline', kind: 'manual', metadata: { facts: ['Deployment pipeline reviewed'], narrative: 'Second observation describing a review of the deployment pipeline.' } });

    const result = await c.contextObservations({ projectId, query: 'deployment', limit: 5 });
    expect(result.observations.length).toBeGreaterThanOrEqual(2);
    expect(result.context).toContain('deployment pipeline');
    // Context joins observations with a blank line.
    expect(result.context.split('\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('/v1/search and /v1/context default to hybrid ranking; MEMSMITH_SEARCH_HYBRID=0 forces FTS', async () => {
    const c = buildClient();
    // facts/narrative clear the task-3 ingest quality floor (score >= 20).
    await c.addObservation({ projectId, content: 'Refactored authentication middleware to use JWT verification', kind: 'manual', metadata: { facts: ['Switched middleware to JWT'], narrative: 'Refactored the authentication middleware layer to use JWT-based verification instead of sessions.' } });

    const prevFlag = process.env.MEMSMITH_SEARCH_HYBRID;
    const hybridSpy = spyOn(PostgresObservationRepository.prototype, 'hybridSearch');
    const ftsSpy = spyOn(PostgresObservationRepository.prototype, 'search');
    try {
      // Default (flag unset): both read endpoints route through hybridSearch.
      delete process.env.MEMSMITH_SEARCH_HYBRID;
      hybridSpy.mockClear();
      await c.searchObservations({ projectId, query: 'authentication', limit: 10 });
      expect(hybridSpy).toHaveBeenCalledTimes(1);
      hybridSpy.mockClear();
      await c.contextObservations({ projectId, query: 'authentication', limit: 5 });
      expect(hybridSpy).toHaveBeenCalledTimes(1);

      // Escape hatch: MEMSMITH_SEARCH_HYBRID=0 forces plain FTS (repo.search),
      // and hybridSearch is not invoked — on BOTH read endpoints.
      process.env.MEMSMITH_SEARCH_HYBRID = '0';
      hybridSpy.mockClear();
      ftsSpy.mockClear();
      await c.searchObservations({ projectId, query: 'authentication', limit: 10 });
      expect(hybridSpy).not.toHaveBeenCalled();
      expect(ftsSpy).toHaveBeenCalledTimes(1);
      hybridSpy.mockClear();
      ftsSpy.mockClear();
      await c.contextObservations({ projectId, query: 'authentication', limit: 5 });
      expect(hybridSpy).not.toHaveBeenCalled();
      expect(ftsSpy).toHaveBeenCalledTimes(1);
    } finally {
      hybridSpy.mockRestore();
      ftsSpy.mockRestore();
      if (prevFlag === undefined) delete process.env.MEMSMITH_SEARCH_HYBRID;
      else process.env.MEMSMITH_SEARCH_HYBRID = prevFlag;
    }
  });

  it('observation_generation_status path: GET /v1/jobs/:id returns the same payload as REST', async () => {
    const c = buildClient();
    const recorded = await c.recordEvent({
      projectId,
      sourceType: 'api',
      eventType: 'mcp_status_test',
      occurredAtEpoch: Date.now(),
    });
    const jobId = (recorded.generationJob as { id: string } | undefined)?.id;
    expect(jobId).toBeTruthy();

    const status = await c.getJobStatus(jobId!);
    expect(status.generationJob.id).toBe(jobId);
    expect(status.generationJob.status).toBe('queued');

    // Compare with the raw HTTP response — same payload contract.
    const raw = await fetch(`http://127.0.0.1:${port}/v1/jobs/${encodeURIComponent(jobId!)}`, {
      headers: { Authorization: `Bearer ${apiKeyRaw}` },
    });
    expect(raw.status).toBe(200);
    const rawJson = await raw.json();
    expect(rawJson.generationJob.id).toBe(jobId);
  });

  it('end-to-end: observation_add → observation_search returns the inserted observation (no provider needed)', async () => {
    const c = buildClient();
    const inserted = await c.addObservation({
      projectId,
      content: 'End-to-end harness verifies idempotent search round-trip',
      kind: 'manual',
      // facts/narrative clear the task-3 ingest quality floor (score >= 20).
      metadata: { facts: ['Round-trip verified'], narrative: 'The end-to-end harness confirms an idempotent search round-trip after insertion.' },
    });
    const found = await c.searchObservations({ projectId, query: 'harness verifies idempotent', limit: 5 });
    expect(found.observations.some(observation => observation.id === inserted.memory.id)).toBe(true);
  });

  it('cross-tenant request to /v1/search is rejected', async () => {
    // Create a foreign project under a different team.
    const otherTeam = await storage.teams.create({ name: 'foreign' });
    const otherProject = await storage.projects.create({ teamId: otherTeam.id, name: 'foreign-p' });

    const c = buildClient();
    let caught: unknown;
    try {
      await c.searchObservations({ projectId: otherProject.id, query: 'anything' });
    } catch (error) {
      caught = error;
    }
    // The api-key is scoped to `projectId`; foreign access yields 403.
    expect(String(caught)).toContain('403');
  });
});
