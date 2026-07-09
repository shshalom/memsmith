// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema, SERVER_POSTGRES_SCHEMA_VERSION } from '../../src/storage/postgres/schema.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';

describe('server_settings schema (migration 4)', () => {
  it('bumps the schema version to 4', () => {
    expect(SERVER_POSTGRES_SCHEMA_VERSION).toBe(4);
  });

  it('creates server_settings with team_id PK and overrides jsonb', async () => {
    const pool = new Pool({ connectionString: CONN });
    try {
      await bootstrapServerPostgresSchema(pool);
      const { rows } = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'server_settings' ORDER BY column_name`);
      const cols = Object.fromEntries(rows.map((r: any) => [r.column_name, r.data_type]));
      expect(cols['team_id']).toBe('text');
      expect(cols['overrides']).toBe('jsonb');
      expect(cols['updated_at']).toContain('timestamp');
    } finally {
      await pool.end();
    }
  });
});
