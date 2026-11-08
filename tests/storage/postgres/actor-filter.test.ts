// Postgres-gated: requires MEMSMITH_TEST_POSTGRES_URL.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
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

// An HNSW scan hands back only ef_search candidates (40 by default) before the
// WHERE clause runs, so a rare actor among many closer rows used to vanish.
describe('actor filter on an HNSW scan crowded by other actors', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let schemaName: string;
  let teamId: string; let projectId: string; let reviewerId: string;

  // Deterministic points scattered around the query vector (e0). A scattered
  // cluster keeps every node reachable in the HNSW graph; identical vectors
  // would leave the outlier unlinked and unfindable for reasons unrelated to
  // the filter.
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const around = (spread: number) => {
    const v = Array.from({ length: 384 }, () => noise() * spread / Math.sqrt(384));
    v[0] += 1;
    return v;
  };

  beforeAll(async () => {
    schemaName = `cm_actor_hnsw_${randomUUID().replaceAll('-', '_')}`;
    const admin = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${q(schemaName)}`);
    await admin.end();
    // Force the planner onto the HNSW index, as it chooses on a large table.
    pool = new pg.Pool({
      connectionString: testDatabaseUrl,
      max: 4,
      options: `-c search_path=${schemaName},public -c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off`,
    });
    await bootstrapServerPostgresSchema(pool as never);
    const storage = createPostgresStorageRepositories(pool as never);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    const repo = new PostgresObservationRepository(pool as never);
    for (let i = 0; i < 600; i++) {
      await repo.create({
        projectId, teamId, kind: 'discovery', content: `crowd ${i}`,
        metadata: { actor: 'Explore' }, embeddingVec: around(0.6),
      });
    }
    reviewerId = (await repo.create({
      projectId, teamId, kind: 'discovery', content: 'the one reviewer row',
      metadata: { actor: 'reviewer' }, embeddingVec: around(1.6),
    })).id;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
    await admin.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    await admin.end();
  });

  it('finds the only matching row by vector even though hundreds of nearer rows belong to another actor', async () => {
    const repo = new PostgresObservationRepository(pool as never);
    const hits = await repo.vectorSearch({ projectId, teamId, query: 'anything', limit: 5, actor: 'reviewer' });
    expect(hits.map((h) => h.id)).toEqual([reviewerId]);
  });
});
