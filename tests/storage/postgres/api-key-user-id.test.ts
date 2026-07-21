// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresAuthRepository } from '../../../src/storage/postgres/auth.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe.if(!!testDatabaseUrl)('api_keys.user_id', () => {
  let pool: pg.Pool;
  let client: any;
  let schemaName: string;
  let teamId: string;
  let auth: PostgresAuthRepository;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_akuid_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' });
    teamId = team.id;
    auth = new PostgresAuthRepository(client);
  });

  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release();
    await pool.end();
  });

  it('createApiKey with userId round-trips through verify (getApiKeyByHash)', async () => {
    const keyHash = `hash-with-user-${randomUUID()}`;
    await auth.createApiKey({
      keyHash,
      teamId,
      actorId: 'actor1',
      userId: 'u1',
    });
    const result = await auth.getApiKeyByHash(keyHash);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('u1');
  });

  it('createApiKey without userId → verify returns null userId (legacy back-compat)', async () => {
    const keyHash = `hash-no-user-${randomUUID()}`;
    await auth.createApiKey({
      keyHash,
      teamId,
      actorId: 'actor2',
    });
    const result = await auth.getApiKeyByHash(keyHash);
    expect(result).not.toBeNull();
    expect(result!.userId).toBeNull();
  });
});
