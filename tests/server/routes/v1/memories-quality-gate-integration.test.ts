// tests/server/routes/v1/memories-quality-gate-integration.test.ts
//
// End-to-end HTTP coverage for the ingest quality gate on POST /v1/memories.
// Follows the same Postgres-backed harness pattern as
// tests/server/server-service.test.ts (createPostgresGraph + ServerService +
// fetch), gated on MEMSMITH_TEST_POSTGRES_URL so the unit suite stays green
// on machines without a test Postgres available.
//
// This file pins the two HAZARD scenarios from the task-3 brief at the real
// HTTP boundary:
//   1. note_add's exact payload shape (kind='user_note',
//      metadata={userDirected:true}) is ACCEPTED despite scoring below floor.
//   2. A low-quality NON-note submission is REJECTED with 422 — the
//      exemption must not become a universal bypass.

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { createHash } from 'crypto';
import { ServerService } from '../../../../src/server/runtime/ServerService.js';
import { DisabledServerQueueManager, DisabledServerGenerationWorkerManager, type ServerServiceGraph } from '../../../../src/server/runtime/types.js';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../../src/storage/postgres/index.js';
import { logger } from '../../../../src/utils/logger.js';

const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;

function createPostgresGraph(pool: pg.Pool, authMode: 'api-key' | 'local-dev'): ServerServiceGraph {
  return {
    runtime: 'server-beta',
    postgres: {
      pool: pool as any,
      bootstrap: { initialized: true, schemaVersion: 1, appliedAt: new Date().toISOString() },
    },
    authMode,
    queueManager: new DisabledServerQueueManager('quality-gate integration test'),
    generationWorkerManager: new DisabledServerGenerationWorkerManager('test'),
  };
}

describe('POST /v1/memories quality gate (HTTP integration)', () => {
  let service: ServerService | null = null;
  const loggerSpies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    if (service) {
      await service.stop();
      service = null;
    }
    loggerSpies.splice(0).forEach(spy => spy.mockRestore());
    mock.restore();
  });

  if (!TEST_DATABASE_URL) {
    it.skip('postgres integration tests skipped (set MEMSMITH_TEST_POSTGRES_URL to enable)', () => {});
    return;
  }

  async function setup() {
    loggerSpies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    );
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await bootstrapServerPostgresSchema(pool);
    const repos = createPostgresStorageRepositories(pool);
    const team = await repos.teams.create({ name: `t3-quality-${Date.now()}-${Math.random()}` });
    const project = await repos.projects.create({ teamId: team.id, name: `t3-quality-proj-${Date.now()}` });
    const rawKey = `cmem_test_t3_quality_${Date.now()}_${Math.random()}`;
    await repos.auth.createApiKey({
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
      teamId: team.id,
      actorId: 'test',
      scopes: ['memories:write', 'memories:read'],
    });

    service = new ServerService({
      graph: createPostgresGraph(pool, 'api-key'),
      port: 0,
      host: '127.0.0.1',
      persistRuntimeState: false,
    });
    await service.start();
    const port = service.getRuntimeState().port;
    return { port, rawKey, projectId: project.id };
  }

  it('accepts a user note despite it scoring below the floor (note_add back-compat)', async () => {
    const { port, rawKey, projectId } = await setup();
    const response = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        projectId,
        content: 'remember this for later',
        kind: 'user_note',
        metadata: { userDirected: true },
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.memory.kind).toBe('user_note');
  });

  it('still rejects a low-quality NON-note submission with 422 (exemption is not a universal bypass)', async () => {
    const { port, rawKey, projectId } = await setup();
    const response = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        projectId,
        content: 'just some flat content with no structure',
        kind: 'manual',
      }),
    });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe('BelowQualityFloor');
    expect(body.quality).toBeLessThan(20);
  });

  it('rejects a submission relabelled as user_note WITHOUT userDirected=true (kind-only is not sufficient)', async () => {
    const { port, rawKey, projectId } = await setup();
    const response = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        projectId,
        content: 'sneaky relabel attempt',
        kind: 'user_note',
        // no metadata.userDirected — must NOT be exempt
      }),
    });
    expect(response.status).toBe(422);
  });

  it('accepts a rich, structured submission that legitimately clears the floor', async () => {
    const { port, rawKey, projectId } = await setup();
    const response = await fetch(`http://127.0.0.1:${port}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rawKey}` },
      body: JSON.stringify({
        projectId,
        content: 'A decision was made about X',
        kind: 'manual',
        obsType: 'decision',
        metadata: {
          facts: ['a', 'b', 'c'],
          narrative: 'A sufficiently long narrative explaining what was decided and why it matters.',
          title: 'A decision',
          concepts: ['x'],
        },
      }),
    });
    expect(response.status).toBe(201);
  });
});
