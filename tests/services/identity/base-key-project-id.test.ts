// SPDX-License-Identifier: Apache-2.0
//
// insertApiKeyHash accepted a projectId parameter and never used it: the INSERT
// listed (id, key_hash, team_id, actor_id, scopes) only. Every freshly minted
// base key therefore landed with api_keys.project_id = NULL.
//
// That is not cosmetic. postgres-auth builds authContext.projectId from
// api_keys.project_id, and resolveRequestDatabase refuses a request with no
// project identity (400 "no project identity"). So a brand-new local project
// could authenticate but every dashboard and /v1 read failed — the dashboard
// rendered a load error while the project looked correctly set up.
//
// The dogfood masked this: its key predates this path and has project_id set.
import { describe, it, expect } from 'bun:test';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type Captured = { text: string; params: unknown[] };

function fakePool(captured: Captured[]) {
  return {
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      // upsertTeamAndProject + the key-hash lookup both read; return empty.
      return { rows: [] as unknown[] };
    },
  };
}

describe('minted base key carries its project id', () => {
  it('writes project_id on the api_keys row', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ms-keyproj-'));
    const captured: Captured[] = [];
    try {
      const store = {
        resolveKeyForTeam: () => null,
        storeKeyForTeam: () => {},
      } as unknown as Parameters<typeof ensureProjectIdentity>[2];

      const { projectId } = await ensureProjectIdentity(fakePool(captured) as never, cwd, store);

      const insert = captured.find(c => /INSERT INTO api_keys/i.test(c.text));
      expect(insert).toBeDefined();
      // The column must actually be in the statement...
      expect(insert!.text).toContain('project_id');
      // ...and bound to this project, not dropped on the floor.
      expect(insert!.params).toContain(projectId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
