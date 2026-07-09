// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { SettingsStore } from '../../src/server/settings/SettingsStore.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-store-test';

describe('SettingsStore', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await pool.query('DELETE FROM server_settings WHERE team_id = $1', [TEAM]);
  });

  it('returns {} for a team with no row', async () => {
    const store = new SettingsStore(pool);
    expect(await store.getTeamOverrides(TEAM)).toEqual({});
  });

  it('upsert-merges without clobbering other keys', async () => {
    const store = new SettingsStore(pool);
    await store.putTeamOverrides(TEAM, { tiering: false });
    await store.putTeamOverrides(TEAM, { ftsWeight: 0.7 });
    expect(await store.getTeamOverrides(TEAM)).toEqual({ tiering: false, ftsWeight: 0.7 });
  });
});
