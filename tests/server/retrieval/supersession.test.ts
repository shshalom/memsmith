// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import pg from 'pg';
import { bootstrapServerPostgresSchema } from '../../../src/storage/postgres/index.js';
import { createIsolatedSchema, dropSchema, poolForSchema } from '../../sdk/pg-isolation.js';
import { resolveSupersessionHead, resolveHeads, maxChainDepth } from '../../../src/server/retrieval/supersession.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;

const TEAM = '11111111-1111-1111-1111-111111111111';
const PROJ = '22222222-2222-2222-2222-222222222222';

// helper: insert an observation; `sup` is the id this row supersedes (or null)
async function insertObs(db: any, id: string, sup: string | null, createdIso: string) {
  await db.query(
    `INSERT INTO observations (id, project_id, team_id, kind, content, obs_type, lifecycle_state, supersedes, created_at, updated_at)
     VALUES ($1,$2,$3,'observation',$4,'decision','open',$5,$6,$6)`,
    [id, PROJ, TEAM, `obs ${id}`, sup, createdIso],
  );
}

describe('supersession chain walk', () => {
  if (!testDatabaseUrl) {
    test.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL for Postgres integration', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: pg.PoolClient;
  let schemaName: string;

  beforeAll(async () => {
    schemaName = await createIsolatedSchema(testDatabaseUrl, 'cm_supersession');
    pool = poolForSchema(testDatabaseUrl, schemaName);
    client = await pool.connect();
    await bootstrapServerPostgresSchema(client);

    // Create team and project to satisfy foreign key constraints
    await client.query(
      `INSERT INTO teams (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [TEAM, 'test-team', new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO projects (id, team_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
      [PROJ, TEAM, 'test-project', new Date().toISOString()],
    );
  });

  afterAll(async () => {
    if (client) {
      client.release();
    }
    if (pool) {
      await pool.end();
    }
    if (schemaName) {
      await dropSchema(testDatabaseUrl, schemaName);
    }
  });

  test('linear chain resolves to head (X<-Y<-Z)', async () => {
    // Z supersedes Y supersedes X; starting from X, head is Z
    await insertObs(pool, 'x', null, '2026-01-01T00:00:00Z');
    await insertObs(pool, 'y', 'x', '2026-01-02T00:00:00Z');
    await insertObs(pool, 'z', 'y', '2026-01-03T00:00:00Z');
    expect(await resolveSupersessionHead(pool, 'x', { teamId: TEAM, projectId: PROJ })).toBe('z');
  });

  test('already-head returns itself', async () => {
    expect(await resolveSupersessionHead(pool, 'z', { teamId: TEAM, projectId: PROJ })).toBe('z');
  });

  test('fork: newest created_at wins', async () => {
    // both f1 and f2 supersede base; f2 is newer -> head is f2
    await insertObs(pool, 'base', null, '2026-02-01T00:00:00Z');
    await insertObs(pool, 'f1', 'base', '2026-02-02T00:00:00Z');
    await insertObs(pool, 'f2', 'base', '2026-02-03T00:00:00Z');
    expect(await resolveSupersessionHead(pool, 'base', { teamId: TEAM, projectId: PROJ })).toBe('f2');
  });

  test('cycle guard terminates (a<->b)', async () => {
    await insertObs(pool, 'ca', null, '2026-03-01T00:00:00Z');
    await insertObs(pool, 'cb', 'ca', '2026-03-02T00:00:00Z');
    await pool.query(`UPDATE observations SET supersedes='cb' WHERE id='ca'`);
    // walk must not hang; returns a valid node in the cycle
    const head = await resolveSupersessionHead(pool, 'ca', { teamId: TEAM, projectId: PROJ });
    expect(['ca', 'cb']).toContain(head);
  });

  test('scope isolation: successor in another team is not followed', async () => {
    const OTHER = '99999999-9999-9999-9999-999999999999';
    const OTHER_PROJ = '88888888-8888-8888-8888-888888888888';

    // Create the other team and project
    await client.query(
      `INSERT INTO teams (id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
      [OTHER, 'other-team', new Date().toISOString()],
    );
    await client.query(
      `INSERT INTO projects (id, team_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`,
      [OTHER_PROJ, OTHER, 'other-project', new Date().toISOString()],
    );

    await insertObs(pool, 'sc', null, '2026-04-01T00:00:00Z');
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, kind, content, obs_type, lifecycle_state, supersedes, created_at, updated_at)
       VALUES ('scx',$1,$2,'observation','x','decision','open','sc','2026-04-02T00:00:00Z','2026-04-02T00:00:00Z')`,
      [OTHER_PROJ, OTHER],
    );
    expect(await resolveSupersessionHead(pool, 'sc', { teamId: TEAM, projectId: PROJ })).toBe('sc');
  });

  test('resolveHeads batch returns head for every input id', async () => {
    const m = await resolveHeads(pool, ['x', 'y', 'z', 'base'], { teamId: TEAM, projectId: PROJ });
    expect(m.get('x')).toBe('z');
    expect(m.get('y')).toBe('z');
    expect(m.get('z')).toBe('z');
    expect(m.get('base')).toBe('f2');
  });

  test('maxChainDepth honors env clamp', () => {
    const prev = process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH;
    process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = '500';
    expect(maxChainDepth()).toBe(256); // clamped
    process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = '0';
    expect(maxChainDepth()).toBe(1);   // clamped
    if (prev === undefined) delete process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH; else process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = prev;
  });
});
