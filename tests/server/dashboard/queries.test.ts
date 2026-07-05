// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { lifecycleBoard, decisionLog, blockedOnWhom, costPanel } from '../../../src/server/dashboard/queries.js';

const testDatabaseUrl = process.env.CLAUDE_MEM_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('dashboard queries', () => {
  if (!testDatabaseUrl) { it.skip('requires CLAUDE_MEM_TEST_POSTGRES_URL', () => {}); return; }

  let pool: pg.Pool;
  let client: any;
  let schemaName: string;
  let teamId: string;
  let projectId: string;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_dash_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'test-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'test-project' });
    teamId = team.id;
    projectId = project.id;

    const repo = new PostgresObservationRepository(client);
    await repo.create({ projectId, teamId, content: 'chose PG', obsType: 'decision', lifecycleState: 'resolved', metadata: { why: 'joins' } });
    await repo.create({ projectId, teamId, content: 'wire auth', obsType: 'task', lifecycleState: 'blocked', metadata: { blocked_on: 'Dana' } });
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('lifecycleBoard groups by state', async () => {
    const board = await lifecycleBoard(client, { teamId, projectId });
    expect(board.blocked.some((o: any) => o.content === 'wire auth')).toBe(true);
    expect(board.resolved.some((o: any) => o.content === 'chose PG')).toBe(true);
  });

  it('decisionLog returns decisions with why', async () => {
    const log = await decisionLog(client, { teamId, projectId });
    expect(log[0].metadata.why).toBe('joins');
  });

  it('blockedOnWhom groups by blocker', async () => {
    const grouped = await blockedOnWhom(client, { teamId, projectId });
    expect(grouped.Dana.some((o: any) => o.content === 'wire auth')).toBe(true);
  });

  it('costPanel returns discoveryTokens + estUsd', async () => {
    const panel = await costPanel(client, { teamId });
    expect(panel).toHaveProperty('discoveryTokens');
    expect(panel).toHaveProperty('estUsd');
  });
});
