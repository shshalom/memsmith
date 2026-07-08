// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { Job } from 'bullmq';
import type { GenerateObservationsForEventJob } from '../../../src/server/jobs/types.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

class StubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;

  constructor(private readonly response: string | Error) {}

  async generate() {
    this.calls += 1;
    if (this.response instanceof Error) throw this.response;
    return { rawText: this.response, providerLabel: this.providerLabel };
  }
}

class SequenceStubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;
  lastReformatReason: string | undefined;
  constructor(private readonly responses: string[]) {}
  async generate(_ctx: unknown, _signal?: AbortSignal, opts?: { reformatReason?: string }) {
    this.lastReformatReason = opts?.reformatReason;
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    return { rawText: this.responses[idx]!, providerLabel: this.providerLabel };
  }
}

const VALID_XML = '<observation><type>discovery</type><title>ok</title><facts><fact>f</fact></facts></observation>';
const GARBAGE = 'sure! here is your observation: it was a discovery about ok.';

describe('ProviderObservationGenerator', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  const dbUrl = testDatabaseUrl;
  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;
  let eventId: string;
  let jobId: string;

  beforeEach(async () => {
    // The generation path reads the active ModeManager mode; load it so this
    // file runs standalone instead of relying on another test file's side effect.
    ModeManager.getInstance().loadMode('code');
    // Pin search_path via poolForSchema (libpq startup packet) so the connections
    // ProviderObservationGenerator acquires for its own transactions land in the
    // test schema deterministically — no racy on('connect') SET search_path.
    schemaName = await createIsolatedSchema(dbUrl, 'cm_phase5_gen');
    pool = poolForSchema(dbUrl, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);

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
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }
    if (schemaName) {
      await dropSchema(dbUrl, schemaName);
    }
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

  it('completes a job using the fake provider response', async () => {
    const xml = '<observation><type>discovery</type><title>OK</title><facts><fact>f</fact></facts></observation>';
    const provider = new StubProvider(xml);
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as Parameters<typeof ProviderObservationGenerator['prototype']['process']>[0]['data'] extends never
        ? never
        : never,
      provider,
    } as unknown as { pool: pg.Pool; provider: ServerGenerationProvider });

    const result = await generator.process(makeJob());
    expect(result.status).toBe('completed');
    expect(result.observationCount).toBe(1);
    expect(provider.calls).toBe(1);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('completed');
  });

  it('marks a job as failed (no retry) when provider returns malformed XML', async () => {
    const provider = new StubProvider('not xml at all');
    const generator = new ProviderObservationGenerator({
      pool: pool as unknown as pg.Pool,
      provider,
    } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0]);

    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);

    const reloaded = await storage.observationGenerationJobs.getByIdForScope({
      id: jobId,
      projectId,
      teamId,
    });
    expect(reloaded?.status).toBe('failed');
  });

  it('reformat guard: malformed then valid → persists, provider called twice', async () => {
    const prev = process.env.MEMSMITH_REFORMAT_RETRIES;
    process.env.MEMSMITH_REFORMAT_RETRIES = '1';
    try {
      const provider = new SequenceStubProvider([GARBAGE, VALID_XML]);
      const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
      const result = await generator.process(makeJob());
      expect(provider.calls).toBe(2);
      expect(provider.lastReformatReason).toBeTruthy();
      expect(result.observationCount).toBe(1);
      const reloaded = await storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
      expect(reloaded?.status).toBe('completed');
    } finally {
      process.env.MEMSMITH_REFORMAT_RETRIES = prev;
    }
  });

  it('reformat guard: still malformed after retries → parse_error, job failed (unchanged terminal outcome)', async () => {
    const prev = process.env.MEMSMITH_REFORMAT_RETRIES;
    process.env.MEMSMITH_REFORMAT_RETRIES = '1';
    try {
      const provider = new SequenceStubProvider([GARBAGE, GARBAGE]);
      const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
      await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);
      expect(provider.calls).toBe(2); // 1 initial + 1 reformat
      const reloaded = await storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
      expect(reloaded?.status).toBe('failed');
    } finally {
      process.env.MEMSMITH_REFORMAT_RETRIES = prev;
    }
  });

  it('reformat guard disabled (retries=0): provider called once, fails on malformed', async () => {
    const prev = process.env.MEMSMITH_REFORMAT_RETRIES;
    process.env.MEMSMITH_REFORMAT_RETRIES = '0';
    try {
      const provider = new SequenceStubProvider([GARBAGE]);
      const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
      await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);
      expect(provider.calls).toBe(1);
    } finally {
      process.env.MEMSMITH_REFORMAT_RETRIES = prev;
    }
  });

  it('reformat guard: a thrown provider error on the retry propagates (not swallowed as format failure)', async () => {
    const prev = process.env.MEMSMITH_REFORMAT_RETRIES;
    process.env.MEMSMITH_REFORMAT_RETRIES = '1';
    try {
      const provider: ServerGenerationProvider = {
        providerLabel: 'claude',
        calls: 0,
        async generate(_c: unknown, _s?: AbortSignal, _o?: { reformatReason?: string }) {
          // first call malformed, second call throws
          (this as { calls: number }).calls += 1;
          if ((this as { calls: number }).calls === 1) return { rawText: GARBAGE, providerLabel: 'claude' as const };
          throw new Error('boom on reformat');
        },
      } as never;
      const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
      await expect(generator.process(makeJob())).rejects.toThrow(/boom on reformat/);
    } finally {
      process.env.MEMSMITH_REFORMAT_RETRIES = prev;
    }
  });
});
