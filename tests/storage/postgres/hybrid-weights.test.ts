// SPDX-License-Identifier: Apache-2.0
// hybridSearch fusion weighting: when FTS is uninformative (a semantic-only
// query that shares no literal words with the answer), down-weighting the FTS
// arm must let a strong vector hit keep its top rank instead of being demoted.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { embed } from '../../../src/server/generation/embedder.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('hybridSearch fusion weighting', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }

  let pool: pg.Pool; let client: any; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_wt_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}, public`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    repo = new PostgresObservationRepository(client);
  }, 120000);

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('accepts explicit ftsWeight/vecWeight and still returns results', async () => {
    for (const c of ['my daily commute takes about 45 minutes each way', 'favorite pizza topping is pepperoni', 'the meeting is on Tuesday']) {
      await repo.create({ projectId, teamId, content: c, embeddingVec: await embed(c) });
    }
    // A semantic query that shares no literal words with the commute answer.
    const results = await repo.hybridSearch({
      projectId, teamId, query: 'how far is my trip to the office', limit: 3,
      ftsWeight: 0.3, vecWeight: 1.0,
    });
    expect(results.length).toBeGreaterThan(0);
    // The commute observation should be top-ranked under vector-dominant fusion.
    expect(results[0].content).toMatch(/commute/);
  }, 120000);
});
