// SPDX-License-Identifier: Apache-2.0
//
// Task 5 — seedHinge is the PoolRegistry.deps.seedHinge implementation: it
// inserts a freshly-provisioned project database's own teams/projects rows so
// the DATA tables' FKs (observations.team_id -> teams.id, .project_id ->
// projects.id) resolve on first write. Mirrors the existing seeding in
// local-runtime.ts's defaultRunImport.
import { describe, it, expect } from 'bun:test';
import { seedHinge } from '../../../src/server/runtime/create-server-service.js';

function fakePool() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as any, calls };
}

describe('seedHinge', () => {
  it('inserts teams then projects with ON CONFLICT DO NOTHING, in that order', async () => {
    const { pool, calls } = fakePool();
    await seedHinge(pool, { teamId: 't1', projectId: 'p1' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain('INSERT INTO teams');
    expect(calls[0]!.text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(calls[0]!.params).toEqual(['t1']);

    expect(calls[1]!.text).toContain('INSERT INTO projects');
    expect(calls[1]!.text).toContain('ON CONFLICT (id) DO NOTHING');
    expect(calls[1]!.params).toEqual(['p1', 't1']);
  });

  it('SECURITY: refuses to seed with an empty teamId (no teams/projects insert)', async () => {
    const { pool, calls } = fakePool();
    await expect(seedHinge(pool, { teamId: '', projectId: 'p1' })).rejects.toThrow(/empty teamId/i);
    expect(calls).toHaveLength(0);
  });

  it('SECURITY: refuses to seed with a blank/whitespace-only teamId', async () => {
    const { pool, calls } = fakePool();
    await expect(seedHinge(pool, { teamId: '   ', projectId: 'p1' })).rejects.toThrow(/empty teamId/i);
    expect(calls).toHaveLength(0);
  });
});
