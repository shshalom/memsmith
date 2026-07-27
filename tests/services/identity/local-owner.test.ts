// SPDX-License-Identifier: Apache-2.0
//
// A local install had no owner. ensureBaseKey minted api_keys with
// user_id = NULL and never created a team_members row, so authContext.role
// resolved to null for every local project — including the dogfood. The Go Team
// wizard is guarded by requireRole('owner'), which meant "Go Team" could never
// be used on ANY local install: POST /v1/convert/test-connection returned
// 403 "requires role owner".
//
// requireWriteRole already accommodates a null role as member-equivalent "so
// existing scope-only keys keep working", but that accommodation was never
// extended to the owner check. The right fix is not to widen the guard: convert
// re-stamps observations with the owner's real user id, so the feature genuinely
// needs an owner to exist. Establish one.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';
import { LOCAL_OWNER_USER_ID } from '../../../src/server/identity/providers/local-provider.js';

type Captured = { text: string; params: unknown[] };

function fakePool(captured: Captured[]) {
  return {
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return { rows: [] as unknown[] };
    },
  };
}

function withCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ms-owner-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe('a local project has an owner', () => {
  it('creates a team_members row with the owner role', async () => {
    await withCwd(async (cwd) => {
      const captured: Captured[] = [];
      const store = {
        resolveKeyForTeam: () => null,
        storeKeyForTeam: () => {},
      } as unknown as Parameters<typeof ensureProjectIdentity>[2];

      await ensureProjectIdentity(fakePool(captured) as never, cwd, store);

      const member = captured.find(c => /INSERT INTO team_members/i.test(c.text));
      expect(member).toBeDefined();
      expect(member!.params).toContain(LOCAL_OWNER_USER_ID);
      // 'owner' is a SQL literal rather than a bound param — assert on the text.
      expect(member!.text).toMatch(/'owner'/);
    });
  });

  it('stamps the minted key with the owner user_id', async () => {
    // authContext.role is resolved by joining api_keys.user_id to team_members;
    // a NULL user_id makes the role unresolvable no matter what rows exist.
    await withCwd(async (cwd) => {
      const captured: Captured[] = [];
      const store = {
        resolveKeyForTeam: () => null,
        storeKeyForTeam: () => {},
      } as unknown as Parameters<typeof ensureProjectIdentity>[2];

      await ensureProjectIdentity(fakePool(captured) as never, cwd, store);

      const key = captured.find(c => /INSERT INTO api_keys/i.test(c.text));
      expect(key).toBeDefined();
      expect(key!.text).toContain('user_id');
      expect(key!.params).toContain(LOCAL_OWNER_USER_ID);
    });
  });

  it('heals an existing project: the owner row is upserted, not skipped', async () => {
    // Projects minted before this change already have their teams/projects rows,
    // so an INSERT that does nothing on conflict would leave them ownerless
    // forever — exactly how the uuid-name placeholder stranded old rows.
    await withCwd(async (cwd) => {
      const captured: Captured[] = [];
      const store = {
        resolveKeyForTeam: () => 'cmem_existing_key',
        storeKeyForTeam: () => {},
      } as unknown as Parameters<typeof ensureProjectIdentity>[2];

      await ensureProjectIdentity(fakePool(captured) as never, cwd, store);

      const member = captured.find(c => /INSERT INTO team_members/i.test(c.text));
      expect(member).toBeDefined();
      expect(member!.text).toMatch(/ON CONFLICT/i);
      // Must not silently do nothing — an ownerless team has to become owned.
      expect(member!.text).toMatch(/DO UPDATE/i);
    });
  });
});
