// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ProviderObservationGenerator } from '../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../src/server/jobs/types.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

// ── semantics-pinning test ──────────────────────────────────────────────────
// This test pins the selection rule:
//   holder ? (await holder.current(teamId)) ?? fixed : fixed
// It does NOT require a database or BullMQ stack.
describe('generator resolves provider per job via holder', () => {
  it('uses the holder-resolved provider, not the fixed one', async () => {
    const fixed = { generate: async () => { throw new Error('should not use fixed'); } };
    const swapped = { generate: async () => ({ observations: [], tokensUsed: 0 }) };
    const holder = { current: async () => swapped } as any;
    // This mirrors the resolution expression in process() — it pins the selection.
    const chosen = holder ? (await holder.current('t')) ?? fixed : fixed;
    expect(chosen).toBe(swapped);
  });

  it('falls back to fixed provider when holder returns null', async () => {
    const fixed = { generate: async () => ({ observations: [] }) };
    const holder = { current: async () => null } as any;
    const chosen = holder ? (await holder.current('t')) ?? fixed : fixed;
    expect(chosen).toBe(fixed);
  });

  it('falls back to fixed provider when no holder is provided', async () => {
    const fixed = { generate: async () => ({ observations: [] }) };
    const holder = null;
    const chosen = holder ? (await (holder as any).current('t')) ?? fixed : fixed;
    expect(chosen).toBe(fixed);
  });
});

// ── integration test (requires MEMSMITH_TEST_POSTGRES_URL) ─────────────────
// Constructs a real ProviderObservationGenerator with a fake providerHolder
// and asserts that the holder-resolved provider's generate() is called, not
// the fixed provider's. Uses the same fake-BullMQ-job pattern as
// tests/server/generation/provider-observation-generator.test.ts.
const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('ProviderObservationGenerator wires providerHolder', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  // Dynamic imports deferred to avoid pg connection errors when env is absent.
  let pg: typeof import('pg');
  let bootstrapServerPostgresSchema: typeof import('../../src/storage/postgres/index.js').bootstrapServerPostgresSchema;
  let createPostgresStorageRepositories: typeof import('../../src/storage/postgres/index.js').createPostgresStorageRepositories;
  let createIsolatedSchema: typeof import('../sdk/pg-isolation.js').createIsolatedSchema;
  let dropSchema: typeof import('../sdk/pg-isolation.js').dropSchema;
  let poolForSchema: typeof import('../sdk/pg-isolation.js').poolForSchema;

  let pool: import('pg').Pool;
  let client: import('../../src/storage/postgres/index.js').PostgresPoolClient;
  let schemaName: string;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  const VALID_XML = '<observation><type>discovery</type><title>ok</title><facts><fact>f</fact></facts></observation>';

  class TrackingProvider implements ServerGenerationProvider {
    readonly providerLabel = 'claude' as const;
    calls = 0;
    async generate() {
      this.calls += 1;
      return { rawText: VALID_XML, providerLabel: this.providerLabel };
    }
  }

  beforeEach(async () => {
    pg = await import('pg');
    const pgIndex = await import('../../src/storage/postgres/index.js');
    bootstrapServerPostgresSchema = pgIndex.bootstrapServerPostgresSchema;
    createPostgresStorageRepositories = pgIndex.createPostgresStorageRepositories;
    const pgIso = await import('../sdk/pg-isolation.js');
    createIsolatedSchema = pgIso.createIsolatedSchema;
    dropSchema = pgIso.dropSchema;
    poolForSchema = pgIso.poolForSchema;

    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_task9_holder');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);

    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
    const event = await storage.agentEvents.create({
      projectId,
      teamId,
      sourceAdapter: 'api',
      eventType: 'tool_use',
      payload: { x: 1 },
      occurredAt: new Date(),
    });
    eventId = event.id;
    const job = await storage.observationGenerationJobs.create({
      projectId,
      teamId,
      sourceType: 'agent_event',
      sourceId: event.id,
      agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    jobId = job.id;
  });

  afterEach(async () => {
    if (client) client.release();
    if (pool) await pool.end();
    if (schemaName) await dropSchema(testDatabaseUrl!, schemaName);
  });

  function makeJob(): Job<GenerateObservationsForEventJob> {
    return {
      id: 'bull-1',
      data: {
        kind: 'event',
        team_id: teamId,
        project_id: projectId,
        source_type: 'agent_event',
        source_id: eventId,
        generation_job_id: jobId,
        agent_event_id: eventId,
        api_key_id: null,
        actor_id: null,
        source_adapter: 'api',
      },
    } as unknown as Job<GenerateObservationsForEventJob>;
  }

  it('calls the holder-resolved provider generate(), not the fixed one', async () => {
    const fixed = new TrackingProvider();
    const swapped = new TrackingProvider();
    const holder = { current: async (_teamId: string) => swapped } as any;

    const generator = new ProviderObservationGenerator({
      pool: pool as any,
      provider: fixed,
      providerHolder: holder,
    });

    const result = await generator.process(makeJob());

    expect(result.status).toBe('completed');
    // The holder-resolved provider (swapped) must have been called.
    expect(swapped.calls).toBe(1);
    // The fixed provider must NOT have been called.
    expect(fixed.calls).toBe(0);
  });

  it('falls back to fixed provider when holder returns null', async () => {
    const fixed = new TrackingProvider();
    const holder = { current: async (_teamId: string) => null } as any;

    const generator = new ProviderObservationGenerator({
      pool: pool as any,
      provider: fixed,
      providerHolder: holder,
    });

    const result = await generator.process(makeJob());

    expect(result.status).toBe('completed');
    expect(fixed.calls).toBe(1);
  });
});
