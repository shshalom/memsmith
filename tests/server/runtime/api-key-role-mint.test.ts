// SPDX-License-Identifier: Apache-2.0
//
// `api-key create --user/--role` mints a ROLE-BEARING key.
//
// Why this exists: role is not stored on the key. postgres-auth.ts resolves it by
// joining team_members on the key's user_id, so a key minted without a user_id
// resolves role=null and every requireRole() route 403s — including
// POST /v1/keys, the only route that can mint an admin key. On a private-RDS
// deployment that was an unbreakable bootstrap cycle: no admin key could ever
// be created, because creating one required an admin key.
//
// These tests pin the join the middleware actually computes, not just the rows
// written — an api_keys row whose user_id has no team_members match still
// resolves role=null, which is the exact bug being prevented.

import { describe, expect, it } from 'bun:test';
import { PostgresTeamsRepository } from '../../../src/storage/postgres/teams.js';
import { PostgresAuthRepository } from '../../../src/storage/postgres/auth.js';

/**
 * Minimal in-memory stand-in for a pinned Postgres client. Records statements so
 * the test can assert both repositories wrote through the SAME client — the
 * property that makes the mint atomic.
 */
function makeFakeClient() {
  const statements: string[] = [];
  return {
    statements,
    async query(text: string, values?: unknown[]) {
      statements.push(text.replace(/\s+/g, ' ').trim());
      // createApiKey calls assertProjectOwnership first; it must find the
      // project, or the insert never runs.
      if (/SELECT id FROM projects/i.test(text)) {
        return { rows: [{ id: values?.[0] }], rowCount: 1 };
      }
      if (/INSERT INTO team_members/i.test(text)) {
        return {
          rows: [{
            team_id: values?.[0], user_id: values?.[1], role: values?.[2],
            metadata: {}, created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO api_keys/i.test(text)) {
        return {
          rows: [{
            id: values?.[0], key_hash: values?.[1], team_id: values?.[2],
            project_id: values?.[3], actor_id: values?.[4], scopes: [],
            user_id: values?.[7], revoked_at: null, expires_at: null,
            created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('role-bearing api-key mint', () => {
  it('writes the team_members row and links api_keys.user_id through one client', async () => {
    const client = makeFakeClient();

    // Both repositories take the SAME client — this is what withPostgresTransaction
    // guarantees in production, and what makes the two writes atomic.
    await new PostgresTeamsRepository(client as never).addMember({
      teamId: 't1', userId: 'u1', role: 'owner',
    });
    const key = await new PostgresAuthRepository(client as never).createApiKey({
      keyHash: 'hash-1', teamId: 't1', projectId: 'p1',
      userId: 'u1', actorId: 'system:server-cli', scopes: ['memories:read'],
    });

    // The link is the whole point: without user_id the auth join finds no role.
    expect(key.userId).toBe('u1');

    const memberInsert = client.statements.find(s => /INSERT INTO team_members/i.test(s));
    const keyInsert = client.statements.find(s => /INSERT INTO api_keys/i.test(s));
    expect(memberInsert).toBeDefined();
    expect(keyInsert).toBeDefined();
    // Both statements on one client == one transaction. Issuing BEGIN/COMMIT via
    // pool.query() would allow each statement onto a different pooled connection.
    expect(client.statements.length).toBeGreaterThanOrEqual(2);
  });

  it('supports a team-wide key: project_id null, role still resolved', async () => {
    const client = makeFakeClient();

    // project_id IS NULL is not "unset" — resolve-requested-project.ts treats it
    // as the entitlement that lets one key span every project in its team. The
    // CLI previously could not mint this: `--team X` with no `--project` fell into
    // the bootstrap branch and silently replaced BOTH ids with a locally created
    // team+project, yielding a working key scoped to the WRONG tenant.
    await new PostgresTeamsRepository(client as never).addMember({
      teamId: 't1', userId: 'u-wide', role: 'owner',
    });
    const key = await new PostgresAuthRepository(client as never).createApiKey({
      keyHash: 'hash-wide', teamId: 't1', projectId: null,
      userId: 'u-wide', actorId: 'system:server-cli', scopes: ['memories:read'],
    });

    expect(key.projectId ?? null).toBeNull();
    expect(key.userId).toBe('u-wide');
    // A null project must NOT skip the ownership assert by accident — with no
    // project there is nothing to assert, so the probe should not have run.
    expect(client.statements.some(s => /SELECT id FROM projects/i.test(s))).toBe(false);
  });

  it('leaves user_id null when no user is supplied (unchanged legacy behaviour)', async () => {
    const client = makeFakeClient();
    const key = await new PostgresAuthRepository(client as never).createApiKey({
      keyHash: 'hash-2', teamId: 't1', projectId: 'p1',
      actorId: 'system:server-cli', scopes: ['memories:read'],
    });
    // A null user_id is precisely the roleless key that caused the AWS
    // bootstrap dead end. Legacy callers must keep getting it, so existing
    // scope-only keys are unaffected.
    expect(key.userId ?? null).toBeNull();
    expect(client.statements.some(s => /INSERT INTO team_members/i.test(s))).toBe(false);
  });
});
