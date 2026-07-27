// SPDX-License-Identifier: Apache-2.0
//
// projects.name was set to the projectId itself (`VALUES ($1, $2, $1)`), so the
// project switcher listed raw UUIDs. The mint path already receives the
// project's cwd, so the folder name was available the whole time — the column
// was only ever filled with the id to satisfy NOT NULL.
//
// Existing rows also need to heal: ON CONFLICT DO NOTHING would leave a project
// minted before this change stuck at its UUID forever.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';

type Captured = { text: string; params: unknown[] };

function fakePool(captured: Captured[]) {
  return {
    query: async (text: string, params?: unknown[]) => {
      captured.push({ text, params: params ?? [] });
      return { rows: [] as unknown[] };
    },
  };
}

function projectsInsert(captured: Captured[]) {
  return captured.find(c => /INSERT INTO projects/i.test(c.text));
}

describe('a project is named after its folder', () => {
  it('uses the directory basename, not the projectId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-name-'));
    const cwd = join(root, 'my-cool-app');
    mkdirSync(cwd, { recursive: true });
    const captured: Captured[] = [];
    try {
      const { projectId } = await ensureProjectIdentity(fakePool(captured) as never, cwd);
      const insert = projectsInsert(captured);
      expect(insert).toBeDefined();
      expect(insert!.params).toContain('my-cool-app');
      // The name must be a real name, not the id wearing a name's clothes.
      expect(insert!.params.filter(p => p === projectId).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('heals a row whose name is still the projectId', async () => {
    // ON CONFLICT DO NOTHING would strand every project minted before this
    // change at its UUID. The upsert must replace a name that equals the id.
    const root = mkdtempSync(join(tmpdir(), 'ms-name-heal-'));
    const cwd = join(root, 'legacy-project');
    mkdirSync(cwd, { recursive: true });
    const captured: Captured[] = [];
    try {
      await ensureProjectIdentity(fakePool(captured) as never, cwd);
      const insert = projectsInsert(captured);
      expect(insert!.text).toMatch(/ON CONFLICT/i);
      expect(insert!.text).toMatch(/DO UPDATE/i);
      // Only heal the placeholder — never clobber a name a user chose.
      expect(insert!.text).toMatch(/projects\.name\s*=\s*projects\.id/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the projectId when the cwd has no usable basename', async () => {
    // A trailing-slash / root-ish path yields an empty basename; the name must
    // still be non-null (the column is NOT NULL), so fall back to the id.
    const root = mkdtempSync(join(tmpdir(), 'ms-name-fallback-'));
    const captured: Captured[] = [];
    try {
      const { projectId } = await ensureProjectIdentity(
        fakePool(captured) as never,
        root + '/',
      );
      const insert = projectsInsert(captured);
      expect(insert!.params.some(p => typeof p === 'string' && p.length > 0)).toBe(true);
      expect(insert!.params).toContain(projectId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
