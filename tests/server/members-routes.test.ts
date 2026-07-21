// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for /v1/members management routes (Task 6: identity-core).
//
// Tests (pg-gated, schema-isolated):
//  (a) Owner adds a member → row present with role.
//  (b) Viewer-scoped caller → 403 on POST.
//  (c) DELETE removes the row AND the removed user's key no longer verifies.
//  (d) Cannot remove the last owner (403).
//
// Mirrors the harness in tests/server/local-dev-team-scope.test.ts /
// connect-keys.test.ts: ephemeral Express server on 127.0.0.1, isolated
// Postgres schema, bun:test beforeEach/afterEach tear-down.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { Server } from '../../src/services/server/Server.js';
import { ServerV1PostgresRoutes } from '../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import {
  bootstrapServerPostgresSchema,
  createPostgresStorageRepositories,
  type PostgresPoolClient,
  type PostgresStorageRepositories,
} from '../../src/storage/postgres/index.js';
import { DisabledServerQueueManager } from '../../src/server/runtime/types.js';
import { logger } from '../../src/utils/logger.js';
import { quoteIdentifier, newApiKey } from '../sdk/pg-isolation.js';
import { verifyPostgresApiKey } from '../../src/server/middleware/postgres-auth.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('GET|POST|PATCH|DELETE /v1/members', () => {
  if (!testDatabaseUrl) {
    it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {});
    return;
  }

  let pool: pg.Pool;
  let client: PostgresPoolClient;
  let schemaName: string;
  let storage: PostgresStorageRepositories;
  let server: Server;
  let port: number;

  // Seeded actors
  let ownerTeamId: string;
  let ownerUserId: string;
  let ownerWriteKey: string;   // memories:write key for the owner

  let secondUserId: string;
  let secondUserWriteKey: string;  // write key for second user (used for viewer-gated tests)
  let secondUserReadKey: string;   // read key for second user

  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    loggerSpies = ['info', 'warn', 'error', 'debug'].map((m) =>
      spyOn(logger, m as 'info').mockImplementation(() => {}),
    );

    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_members_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    pool.on('connect', (c) => { c.query(`SET search_path TO ${quoteIdentifier(schemaName)}`).catch(() => {}); });

    storage = createPostgresStorageRepositories(client);

    // ── Owner / team ──────────────────────────────────────────────────────────
    ownerUserId = `user_owner_${randomUUID().replaceAll('-', '_')}`;
    const team = await storage.teams.create({ name: 'Test Team' });
    ownerTeamId = team.id;
    // Seed the owner membership row
    await storage.teams.addMember({ teamId: ownerTeamId, userId: ownerUserId, role: 'owner' });

    // Owner write key (memories:read + memories:write; user_id → role resolved by middleware)
    const ownerW = newApiKey(); ownerWriteKey = ownerW.raw;
    await storage.auth.createApiKey({
      keyHash: ownerW.hash,
      teamId: ownerTeamId,
      userId: ownerUserId,
      actorId: 'test-owner',
      scopes: ['memories:read', 'memories:write'],
    });

    // ── Second user (will be added as member / viewer in tests) ───────────────
    secondUserId = `user_second_${randomUUID().replaceAll('-', '_')}`;
    // Write key for second user — initially has NO membership row (tests add it)
    const secW = newApiKey(); secondUserWriteKey = secW.raw;
    await storage.auth.createApiKey({
      keyHash: secW.hash,
      teamId: ownerTeamId,
      userId: secondUserId,
      actorId: 'test-second',
      scopes: ['memories:read', 'memories:write'],
    });
    const secR = newApiKey(); secondUserReadKey = secR.raw;
    await storage.auth.createApiKey({
      keyHash: secR.hash,
      teamId: ownerTeamId,
      userId: secondUserId,
      actorId: 'test-second',
      scopes: ['memories:read'],
    });

    // ── Express server ────────────────────────────────────────────────────────
    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker.cjs',
      runtime: 'server-beta',
      getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
    });
    server.registerRoutes(new ServerV1PostgresRoutes({
      pool: pool as never,
      queueManager: new DisabledServerQueueManager('disabled'),
      authMode: 'api-key',
    }));
    server.finalizeRoutes();
    await server.listen(0, '127.0.0.1');
    const addr = server.getHttpServer()?.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    port = addr.port;
  });

  afterEach(async () => {
    try { await server.close(); } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') throw e;
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    client.release();
    await pool.end();
    loggerSpies.forEach((s) => s.mockRestore());
    mock.restore();
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  // ── (a) Owner adds a member → row present with role ──────────────────────────
  it('(a) owner can add a member and row appears with correct role', async () => {
    const newUserId = `user_new_${randomUUID().replaceAll('-', '_')}`;

    const addRes = await fetch(url('/v1/members'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerWriteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: newUserId, role: 'member' }),
    });
    expect(addRes.status).toBe(200);
    const addBody = await addRes.json() as { member: { userId: string; role: string } };
    expect(addBody.member.userId).toBe(newUserId);
    expect(addBody.member.role).toBe('member');

    // Verify the row is present via GET /v1/members
    const listRes = await fetch(url('/v1/members'), {
      headers: { Authorization: `Bearer ${ownerWriteKey}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { members: { userId: string; role: string }[] };
    const found = listBody.members.find(m => m.userId === newUserId);
    expect(found).toBeDefined();
    expect(found?.role).toBe('member');
  });

  // ── (b) Viewer-scoped caller → 403 on POST ───────────────────────────────────
  it('(b) viewer-scoped caller gets 403 on POST /v1/members', async () => {
    // Add secondUser as viewer first so they have a valid key with a role
    await storage.teams.addMember({ teamId: ownerTeamId, userId: secondUserId, role: 'viewer' });

    const thirdUserId = `user_third_${randomUUID().replaceAll('-', '_')}`;
    // Use the write key for secondUser (which has viewer role in the team)
    const addRes = await fetch(url('/v1/members'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secondUserWriteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: thirdUserId, role: 'viewer' }),
    });
    // requireRole('admin') should reject a viewer with 403
    expect(addRes.status).toBe(403);
  });

  // ── (c) DELETE removes row AND removed user's key no longer verifies ─────────
  it('(c) DELETE removes the membership row and revokes the removed user\'s keys', async () => {
    // Add secondUser as a member
    await storage.teams.addMember({ teamId: ownerTeamId, userId: secondUserId, role: 'member' });

    // Confirm the key verifies before deletion
    const beforeVerify = await verifyPostgresApiKey(pool as never, secondUserWriteKey, ['memories:write']);
    expect(beforeVerify).not.toBeNull();

    // Owner deletes secondUser
    const delRes = await fetch(url(`/v1/members/${secondUserId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerWriteKey}` },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { removed: boolean; userId: string };
    expect(delBody.removed).toBe(true);
    expect(delBody.userId).toBe(secondUserId);

    // The membership row must be gone
    const listRes = await fetch(url('/v1/members'), {
      headers: { Authorization: `Bearer ${ownerWriteKey}` },
    });
    const listBody = await listRes.json() as { members: { userId: string }[] };
    const stillThere = listBody.members.find(m => m.userId === secondUserId);
    expect(stillThere).toBeUndefined();

    // The removed user's API key must no longer verify (revoked_at is set)
    const afterVerify = await verifyPostgresApiKey(pool as never, secondUserWriteKey, ['memories:write']);
    expect(afterVerify).toBeNull();

    const afterVerifyRead = await verifyPostgresApiKey(pool as never, secondUserReadKey, ['memories:read']);
    expect(afterVerifyRead).toBeNull();
  });

  // ── (d) Cannot remove the last owner (403) ────────────────────────────────────
  it('(d) cannot remove the last owner (403)', async () => {
    // ownerUserId is the only owner. Trying to remove them must fail.
    const delRes = await fetch(url(`/v1/members/${ownerUserId}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerWriteKey}` },
    });
    expect(delRes.status).toBe(403);
    const body = await delRes.json() as { error: string; message: string };
    expect(body.error).toBe('Forbidden');
    expect(body.message).toContain('last owner');
  });

  // ── Additional: PATCH changes role ───────────────────────────────────────────
  it('PATCH /v1/members/:userId changes the role', async () => {
    await storage.teams.addMember({ teamId: ownerTeamId, userId: secondUserId, role: 'viewer' });

    const patchRes = await fetch(url(`/v1/members/${secondUserId}`), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerWriteKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json() as { member: { role: string } };
    expect(patchBody.member.role).toBe('member');
  });

  // ── Additional: GET /v1/members requires ≥member (viewer is OK) ──────────────
  it('GET /v1/members works for a member-role caller', async () => {
    await storage.teams.addMember({ teamId: ownerTeamId, userId: secondUserId, role: 'member' });

    // secondUserWriteKey has write scopes but the role is member — GET only requires ≥member
    const listRes = await fetch(url('/v1/members'), {
      headers: { Authorization: `Bearer ${secondUserWriteKey}` },
    });
    expect(listRes.status).toBe(200);
  });

  // ── Additional: cannot assign role above caller's own (admin cannot make owner) ──
  it('admin cannot promote a user to owner (above own role)', async () => {
    // Promote secondUser to admin first (using owner key)
    await storage.teams.addMember({ teamId: ownerTeamId, userId: secondUserId, role: 'admin' });

    // Create an admin-scoped write key for secondUser
    const adminKey = newApiKey();
    await storage.auth.createApiKey({
      keyHash: adminKey.hash,
      teamId: ownerTeamId,
      userId: secondUserId,
      actorId: 'test-admin',
      scopes: ['memories:read', 'memories:write'],
    });

    const thirdUserId = `user_third_${randomUUID().replaceAll('-', '_')}`;
    // Admin tries to add a user with role 'owner' (above admin)
    const addRes = await fetch(url('/v1/members'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey.raw}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: thirdUserId, role: 'owner' }),
    });
    expect(addRes.status).toBe(403);
    const body = await addRes.json() as { message: string };
    expect(body.message).toContain('above your own');
  });
});
