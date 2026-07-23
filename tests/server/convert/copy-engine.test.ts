import { describe, it, expect } from 'bun:test';
import { runCopy, verifyCopy, COPY_TABLES, type CopyDeps } from '../../../src/server/convert/copy-engine.js';

function makeFakeDeps(): { deps: CopyDeps; remote: Record<string, Array<Record<string, unknown>>> } {
  const local: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  const remote: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  local.observations = [
    { id: 'o1', metadata: { createdByUserId: 'local-owner' }, content: 'a' },
    { id: 'o2', metadata: {}, content: 'b' },
  ];
  const deps: CopyDeps = {
    readRows: async (t) => local[t] ?? [],
    upsertRows: async (t, rows) => {
      const seen = new Set((remote[t] ?? []).map(r => r.id));
      for (const r of rows) if (!seen.has(r.id)) remote[t].push(r);
    },
    countRows: async (which, t) => (which === 'local' ? local[t] : remote[t]).length,
  };
  return { deps, remote };
}

describe('copy-engine', () => {
  it('COPY_TABLES excludes team-account tables and is FK-safe ordered', () => {
    expect(COPY_TABLES).toEqual([
      'projects',
      'server_sessions',
      'agent_events',
      'observation_generation_jobs',
      'observations',
      'observation_sources',
      'observation_generation_job_events',
    ]);
    for (const t of ['teams', 'team_members', 'api_keys', 'server_settings']) {
      expect(COPY_TABLES).not.toContain(t);
    }
  });

  it('re-stamps observation attribution to the owner during copy', async () => {
    const { deps, remote } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    expect(remote.observations.find(r => r.id === 'o1')?.metadata).toMatchObject({ createdByUserId: 'user-42' });
    expect(remote.observations.find(r => r.id === 'o2')?.metadata).toMatchObject({ createdByUserId: 'user-42' });
  });

  it('is idempotent — running twice does not duplicate rows', async () => {
    const { deps, remote } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    await runCopy(deps, 'user-42');
    expect(remote.observations).toHaveLength(2);
  });

  it('verifyCopy ok when remote counts >= local for every table', async () => {
    const { deps } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    const v = await verifyCopy(deps);
    expect(v.ok).toBe(true);
    expect(v.mismatches).toEqual([]);
  });
});
