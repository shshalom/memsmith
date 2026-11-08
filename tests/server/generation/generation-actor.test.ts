// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import type { Job } from 'bullmq';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../../src/storage/postgres/index.js';
import { PostgresServerSessionsRepository } from '../../../src/storage/postgres/server-sessions.js';
import { ProviderObservationGenerator } from '../../../src/server/generation/ProviderObservationGenerator.js';
import type { ServerGenerationProvider } from '../../../src/server/generation/providers/shared/types.js';
import type { ServerGenerationJobPayload } from '../../../src/server/jobs/types.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

const OBSERVATION_XML = '<observation><type>discovery</type><title>Queue drains in order</title><facts><fact>FIFO</fact></facts><narrative>The queue drains in FIFO order.</narrative></observation>';
const SUMMARY_XML = '<summary><request>Review the queue</request><investigated>drain order</investigated><learned>FIFO</learned><completed>review</completed><next_steps>none</next_steps></summary>';

function provider(rawText: string): ServerGenerationProvider {
  return { providerLabel: 'claude', generate: async () => ({ rawText, providerLabel: 'claude' }) } as never;
}

describe('generated observations carry the actors of their source events', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    ModeManager.getInstance().loadMode('code');
    schemaName = await createIsolatedSchema(testDatabaseUrl!, 'cm_gen_actor');
    pool = poolForSchema(testDatabaseUrl!, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);
    storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id;
    projectId = project.id;
  });

  afterEach(async () => {
    client?.release();
    await pool?.end();
    if (schemaName) await dropSchema(testDatabaseUrl!, schemaName);
  });

  const generator = (rawText: string) => new ProviderObservationGenerator(
    { pool, provider: provider(rawText) } as unknown as ConstructorParameters<typeof ProviderObservationGenerator>[0],
  );

  async function observationMetadata(): Promise<Array<Record<string, unknown>>> {
    const rows = await pool.query<{ metadata: Record<string, unknown> }>('SELECT metadata FROM observations');
    return rows.rows.map((r) => r.metadata);
  }

  function baseJob(extra: Record<string, unknown>): Job<ServerGenerationJobPayload> {
    return {
      id: 'bull-1',
      data: { team_id: teamId, project_id: projectId, api_key_id: null, actor_id: null, source_adapter: 'api', ...extra },
    } as unknown as Job<ServerGenerationJobPayload>;
  }

  it('an observation generated from one event takes that event\'s actor', async () => {
    const event = await storage.agentEvents.create({
      projectId, teamId, sourceAdapter: 'hook', eventType: 'tool_use',
      payload: { tool_name: 'Read', actor: 'reviewer' }, occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'agent_event', sourceId: event.id, agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    await generator(OBSERVATION_XML).process(baseJob({
      kind: 'event', source_type: 'agent_event', source_id: event.id, generation_job_id: job.id, agent_event_id: event.id,
    }));
    const [metadata] = await observationMetadata();
    expect(metadata.actor).toBe('reviewer');
    expect(metadata.actors).toEqual(['reviewer']);
  });

  async function summarize(actors: Array<string | undefined>): Promise<Record<string, unknown>> {
    const session = await new PostgresServerSessionsRepository(client).create({ projectId, teamId, externalSessionId: `ext-${Math.random()}` });
    for (const [i, actor] of actors.entries()) {
      await storage.agentEvents.create({
        projectId, teamId, serverSessionId: session.id, sourceAdapter: 'hook', eventType: 'tool_use',
        payload: { tool_name: 'Read', n: i, ...(actor ? { actor } : {}) }, occurredAt: new Date(Date.now() + i),
      });
    }
    const job = await storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'session_summary', sourceId: session.id, serverSessionId: session.id,
      jobType: 'session_summary_generate',
    });
    await generator(SUMMARY_XML).process(baseJob({
      kind: 'summary', source_type: 'session_summary', source_id: session.id, generation_job_id: job.id, server_session_id: session.id,
    }));
    const [metadata] = await observationMetadata();
    return metadata;
  }

  it('a summary over events from several actors lists them all and sets no single actor', async () => {
    const metadata = await summarize(['reviewer', 'Explore', 'reviewer']);
    expect(metadata).not.toHaveProperty('actor');
    expect(metadata).not.toHaveProperty('unattributed');
    expect(metadata.actors).toEqual(['reviewer', 'Explore']);
  });

  it('does not credit a mostly unattributed summary to the few named events', async () => {
    const metadata = await summarize([...Array.from({ length: 200 }, () => undefined), 'Explore', 'Explore', 'Explore']);
    expect(metadata).not.toHaveProperty('actor');
    expect(metadata.actors).toEqual(['Explore']);
    expect(metadata.unattributed).toBe(true);
  });

  it('an observation from an event without an actor gets no actor keys', async () => {
    const event = await storage.agentEvents.create({
      projectId, teamId, sourceAdapter: 'hook', eventType: 'tool_use', payload: { tool_name: 'Read' }, occurredAt: new Date(),
    });
    const job = await storage.observationGenerationJobs.create({
      projectId, teamId, sourceType: 'agent_event', sourceId: event.id, agentEventId: event.id,
      jobType: 'observation_generate_for_event',
    });
    await generator(OBSERVATION_XML).process(baseJob({
      kind: 'event', source_type: 'agent_event', source_id: event.id, generation_job_id: job.id, agent_event_id: event.id,
    }));
    const [metadata] = await observationMetadata();
    expect(metadata).not.toHaveProperty('actor');
    expect(metadata).not.toHaveProperty('actors');
  });
});
