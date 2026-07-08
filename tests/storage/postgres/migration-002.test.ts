// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('migration 002: typed + lifecycle columns', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_mig2_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
  });
  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('adds obs_type, lifecycle_state, supersedes, quality to observations', async () => {
    const { rows } = await client.query(
      `SELECT column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name='observations'
         AND column_name IN ('obs_type','lifecycle_state','supersedes','quality')`
    );
    const cols = Object.fromEntries(rows.map((r: any) => [r.column_name, r]));
    expect(cols.obs_type).toBeDefined();
    expect(cols.lifecycle_state).toBeDefined();
    expect(cols.lifecycle_state.column_default).toContain('open');
    expect(cols.supersedes).toBeDefined();
    expect(cols.quality).toBeDefined();
  });

  it('enforces the lifecycle_state CHECK constraint', async () => {
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    await expect(client.query(
      `INSERT INTO observations (id, project_id, team_id, kind, content, lifecycle_state)
       VALUES ($1, $2, $3, 'observation', 'x', 'not_a_state')`,
      [randomUUID(), project.id, team.id]
    )).rejects.toThrow();
  });

  it('records migration version 2', async () => {
    const { rows } = await client.query(
      `SELECT version FROM server_beta_schema_migrations WHERE version=2`
    );
    expect(rows).toHaveLength(1);
  });
});
