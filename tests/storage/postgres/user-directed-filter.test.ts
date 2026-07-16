// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('userDirected search filter', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_ud_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`); await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' }); const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id; repo = new PostgresObservationRepository(client);
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'auth uses JWT tokens for sessions' });
    await repo.create({ projectId, teamId, kind: 'observation', content: 'auth middleware validates JWT tokens' });
  });
  afterEach(async () => { await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(()=>{}); client.release(); await pool.end(); });

  it('userDirected:true returns ONLY user_note rows', async () => {
    const hits = await repo.search({ projectId, teamId, query: 'auth JWT', userDirected: true });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('user_note');
  });
  it('unfiltered returns both', async () => {
    const hits = await repo.search({ projectId, teamId, query: 'auth JWT' });
    expect(hits.length).toBe(2);
  });
});
