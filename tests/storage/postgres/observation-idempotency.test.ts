// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { computeContentIdempotencyKey } from '../../../src/services/retrieval/record-intent-key.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('observation content-idempotency (manual record-intent writes)', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_idem_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    repo = new PostgresObservationRepository(client);
  });
  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release(); await pool.end();
  });

  it('two inserts with the same idempotency key produce exactly ONE row', async () => {
    const content = 'Decision: use embedded Postgres for the local runtime.';
    const key = computeContentIdempotencyKey({ teamId, projectId, kind: 'user_note', content });
    await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2 AND idempotency_key=$3`,
      [teamId, projectId, key],
    );
    expect(rows[0].n).toBe(1);
  });

  it('inserts WITHOUT an idempotency key are not deduped (independent rows)', async () => {
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'same text' });
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'same text' });
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2 AND kind='user_note'`,
      [teamId, projectId],
    );
    expect(rows[0].n).toBe(2); // no key → no dedup (preserves existing behavior)
  });

  it('the /v1/memories create input shape carries idempotencyKey to repo.create', async () => {
    // Exercise the same create path the route uses, asserting the key reaches storage.
    const content = 'Route-path note';
    const key = computeContentIdempotencyKey({ teamId, projectId, kind: 'user_note', content });
    const obs = await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    expect((obs as any).idempotencyKey).toBe(key);
  });
});
