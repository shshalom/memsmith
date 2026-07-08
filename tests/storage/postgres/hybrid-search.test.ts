// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { embed } from '../../../src/server/generation/embedder.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('hybridSearch', () => {
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
    schemaName = `cm_hybrid_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}, public`);
    await bootstrapServerPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'test-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'test-project' });
    teamId = team.id;
    projectId = project.id;

    repo = new PostgresObservationRepository(client);

    for (const c of ['auth uses JWT tokens', 'payment retries on 500', 'JWT rotation policy', 'CSS grid layout tweak']) {
      await repo.create({ projectId, teamId, content: c, embeddingVec: await embed(c) });
    }
  }, 180000);

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('returns auth/JWT results ahead of unrelated ones for a semantic query', async () => {
    const results = await repo.hybridSearch({ projectId, teamId, query: 'how does authentication work', limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => /JWT|auth/i.test(r.content))).toBe(true);
    expect(results[0].content).not.toMatch(/CSS grid/);
  }, 180000);

  it('respects scope and filters', async () => {
    const decisions = await repo.hybridSearch({ projectId, teamId, query: 'auth', obsType: 'decision' });
    expect(decisions.every(r => r.obsType === 'decision')).toBe(true);
  }, 60000);

  it('accepts a platformSource filter without error', async () => {
    // The observations here have no server_session (thus no platform), so a
    // platformSource filter should simply return the FTS-arm-filtered set —
    // the point is the param threads through hybridSearch to search() cleanly.
    const results = await repo.hybridSearch({ projectId, teamId, query: 'JWT', platformSource: 'claude-code' });
    expect(Array.isArray(results)).toBe(true);
  }, 60000);

  it('degrades to FTS results when the vector arm throws (embedder down)', async () => {
    // With hybrid as the default read path, a failing embedder must NOT fail the
    // whole search — the vector arm is caught and hybridSearch returns the FTS
    // ranking. Simulate the embedder being down by making vectorSearch (which
    // multiVectorSearch calls) reject.
    const vecSpy = spyOn(PostgresObservationRepository.prototype, 'vectorSearch')
      .mockImplementation(() => Promise.reject(new Error('embedder unavailable')));
    try {
      const results = await repo.hybridSearch({ projectId, teamId, query: 'JWT rotation', limit: 3 });
      // FTS still finds the lexical matches — the search did not 500.
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => /JWT/i.test(r.content))).toBe(true);
    } finally {
      vecSpy.mockRestore();
    }
  }, 60000);
});
