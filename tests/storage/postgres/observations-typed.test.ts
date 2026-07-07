// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('observations repository — typed + lifecycle', () => {
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
    schemaName = `cm_obs_typed_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);

    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 'test-team' });
    const project = await storage.projects.create({ teamId: team.id, name: 'test-project' });
    teamId = team.id;
    projectId = project.id;

    repo = new PostgresObservationRepository(client);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('persists and maps obsType, lifecycleState, quality', async () => {
    const obs = await repo.create({
      projectId,
      teamId,
      content: 'chose Postgres over Mongo',
      obsType: 'decision',
      lifecycleState: 'resolved',
      quality: 80,
      metadata: { why: 'relational fit', rejected_alternatives: ['Mongo — no joins'] },
    });
    expect(obs.obsType).toBe('decision');
    expect(obs.lifecycleState).toBe('resolved');
    expect(obs.quality).toBe(80);
    expect(obs.metadata.why).toBe('relational fit');
  });

  it('defaults lifecycleState to open and backfills obsType from metadata.type', async () => {
    const obs = await repo.create({
      projectId,
      teamId,
      content: 'noticed a race',
      metadata: { type: 'bug' },
    });
    expect(obs.lifecycleState).toBe('open');
    expect(obs.obsType).toBe('bug'); // fell back to metadata.type
  });

  it('filters search by obsType and lifecycleState', async () => {
    await repo.create({ projectId, teamId, content: 'auth decision alpha', obsType: 'decision', lifecycleState: 'resolved' });
    await repo.create({ projectId, teamId, content: 'auth task beta', obsType: 'task', lifecycleState: 'open' });

    const decisions = await repo.search({ projectId, teamId, query: 'auth', obsType: 'decision' });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every(o => o.obsType === 'decision')).toBe(true);

    const openItems = await repo.search({ projectId, teamId, query: 'auth', lifecycleState: 'open' });
    expect(openItems.length).toBeGreaterThan(0);
    expect(openItems.every(o => o.lifecycleState === 'open')).toBe(true);
  });
});
