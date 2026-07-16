// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { userNotes } from '../../../src/server/dashboard/queries.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"','""')}"`;

describe('userNotes dashboard query', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string; let teamId: string; let projectId: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 }); client = await pool.connect();
    schemaName = `cm_notes_${randomUUID().replaceAll('-','_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`); await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' }); const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    const repo = new PostgresObservationRepository(client);
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'my saved note' });
    await repo.create({ projectId, teamId, kind: 'observation', content: 'ambient obs' });
  });
  afterEach(async () => { await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(()=>{}); client.release(); await pool.end(); });

  it('returns only user_note rows for the scope', async () => {
    const notes = await userNotes(client, { teamId, projectId });
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain('my saved note');
  });
});
