// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';

const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
mock.module('../../../src/server/generation/embedder.js', () => ({
  embed: async () => vector,
  embedBatch: async (texts: string[]) => texts.map(() => vector),
}));

import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('actor filter in the vector arm of hybrid search', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: pg.PoolClient; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 2 });
    client = await pool.connect();
    schemaName = `cm_actor_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}, public`);
    await bootstrapServerPostgresSchema(client as never);
    const storage = createPostgresStorageRepositories(client as never);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id; repo = new PostgresObservationRepository(client as never);
    for (const [name, metadata] of [['reviewer', { actor: 'reviewer' }], ['explore', { actor: 'Explore' }], ['legacy', {}]] as const) {
      ids[name] = (await repo.create({ projectId, teamId, kind: 'discovery', content: `alpha ${name}`, metadata, embeddingVec: vector })).id;
    }
  });
  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('returns only the actor\'s rows when the match comes from embeddings alone', async () => {
    const hits = await repo.hybridSearch({ projectId, teamId, query: 'zzqx-no-lexical-match', limit: 10, actor: 'reviewer' });
    expect(hits.map((h) => h.id)).toEqual([ids.reviewer]);
  });

  it('returns every embedded row without an actor filter', async () => {
    const hits = await repo.hybridSearch({ projectId, teamId, query: 'zzqx-no-lexical-match', limit: 10 });
    expect(hits.map((h) => h.id).sort()).toEqual(Object.values(ids).sort());
  });
});
