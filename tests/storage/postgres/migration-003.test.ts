// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema } from '../../../src/storage/postgres/index.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('migration 003: pgvector', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl });
    client = await pool.connect();
    schemaName = `cm_mig3_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
  });
  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('installs the vector extension', async () => {
    const { rows } = await client.query(`SELECT 1 FROM pg_extension WHERE extname='vector'`);
    expect(rows).toHaveLength(1);
  });

  it('adds a 384-dim embedding_vec column', async () => {
    const { rows } = await client.query(
      `SELECT a.atttypmod
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = 'observations'
         AND a.attname = 'embedding_vec'
         AND n.nspname = current_schema()`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].atttypmod).toBe(384);
  });

  it('records migration version 3', async () => {
    const { rows } = await client.query(
      `SELECT version FROM server_beta_schema_migrations WHERE version=3`
    );
    expect(rows).toHaveLength(1);
  });
});
