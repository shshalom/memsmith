// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('observation embedding_vec round-trip', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }

  let pool: pg.Pool;
  let client: any;
  let schemaName: string;
  let teamId: string;
  let projectId: string;
  let repo: PostgresObservationRepository;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_obs_emb_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'test-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'test-project' });
    teamId = team.id;
    projectId = project.id;

    repo = new PostgresObservationRepository(client);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('stores and returns a 384-dim embedding_vec', async () => {
    const vec = Array.from({ length: 384 }, (_, i) => (i % 7) / 10);
    const obs = await repo.create({ projectId, teamId, content: 'x', embeddingVec: vec });
    expect(obs.embeddingVec).toHaveLength(384);
    expect(obs.embeddingVec![0]).toBeCloseTo(vec[0], 5);
  });

  it('stores null embedding_vec when not provided', async () => {
    const obs = await repo.create({ projectId, teamId, content: 'no embedding' });
    expect(obs.embeddingVec).toBeNull();
  });

  it('embed-on-write: manual insert path persists a non-null embedding_vec (regression for /v1/memories)', async () => {
    // Mirror the /v1/memories handler's create semantics: embed the content
    // via the shared helper, then repo.create with embeddingVec.
    const { embedForPersist } = await import('../../../src/server/generation/embed-for-persist.js');
    const content = 'We chose embedded Postgres over Docker for a frictionless local runtime.';
    const embeddingVec = await embedForPersist(content);
    expect(embeddingVec).not.toBeNull();          // content is embeddable
    const obs = await repo.create({ projectId, teamId, kind: 'manual', content, embeddingVec });
    expect(obs.embeddingVec).toHaveLength(384);    // persisted + round-tripped

    // And it is semantically retrievable via the hybrid search path.
    const hits = await repo.hybridSearch({
      projectId, teamId, query: 'why did we pick postgres for local', limit: 5,
    });
    expect(hits.some(o => o.id === obs.id)).toBe(true);
  });
});
