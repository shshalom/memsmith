// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { costPanel } from '../../src/server/dashboard/queries.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-cost-test';

describe('costPanel real savings', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    // Ensure the team row exists (usage_events has a FK to teams)
    await pool.query(
      `INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [TEAM, TEAM]);
    await pool.query('DELETE FROM usage_events WHERE team_id = $1', [TEAM]);
    // two compression events: saved 150 and 50 tokens; pre 200 and 100
    await pool.query(
      `INSERT INTO usage_events (id, team_id, kind, quantity, metadata) VALUES
        ('c1',$1,'compression',150,'{"preTokens":200,"postTokens":50,"tier":"tiered"}'::jsonb),
        ('c2',$1,'compression',50,'{"preTokens":100,"postTokens":50,"tier":"tiered"}'::jsonb)`,
      [TEAM]);
  });

  it('aggregates saved tokens, pct, and usd at the resolved rate', async () => {
    const resolver = { inputRatePerMtok: async () => 5, provider: async () => 'ollama' } as any;
    const panel = await costPanel(pool, { teamId: TEAM } as any, resolver);
    expect(panel.savedTokens).toBe(200);       // 150 + 50
    expect(panel.preTokens).toBe(300);         // 200 + 100
    expect(panel.pctSmaller).toBeCloseTo(200 / 300, 5);
    expect(panel.estUsdSaved).toBeCloseTo((200 / 1_000_000) * 5, 9);
    expect(panel.localGeneration).toBe(true);  // ollama
  });

  it('guards divide-by-zero when there is no compression', async () => {
    const resolver = { inputRatePerMtok: async () => 5, provider: async () => 'claude' } as any;
    const panel = await costPanel(pool, { teamId: 'team-empty' } as any, resolver);
    expect(panel.savedTokens).toBe(0);
    expect(panel.pctSmaller).toBe(0);
    expect(panel.localGeneration).toBe(false);
  });
});
