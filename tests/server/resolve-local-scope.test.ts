import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveLocalScope } from '../../src/server/runtime/resolve-local-scope.js';

function fakePool() {
  const calls: any[] = [];
  return { calls, query: async (t: string, v?: unknown[]) => { calls.push({ t, v }); return { rows: [], rowCount: 0 }; } } as any;
}

describe('resolveLocalScope (env > marker > mint)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'scope-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); delete process.env.MEMSMITH_LOCAL_DEV_TEAM_ID; delete process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID; });

  it('env wins when set', async () => {
    process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = 'envteam';
    process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = 'envproj';
    const s = await resolveLocalScope({ cwd, pool: fakePool() });
    expect(s).toEqual({ teamId: 'envteam', projectId: 'envproj' });
  });

  it('marker wins when env unset and marker present', async () => {
    mkdirSync(join(cwd, '.memsmith'), { recursive: true });
    writeFileSync(join(cwd, '.memsmith', 'project.json'), JSON.stringify({ teamId: 'mteam', projectId: 'mproj', note: 'x' }));
    const s = await resolveLocalScope({ cwd, pool: fakePool() });
    expect(s).toEqual({ teamId: 'mteam', projectId: 'mproj' });
  });

  it('mints (writes marker + upserts rows) when neither env nor marker', async () => {
    const pool = fakePool();
    const s = await resolveLocalScope({ cwd, pool });
    expect(s.teamId).toMatch(/[0-9a-f-]{36}/);
    expect(s.projectId).toMatch(/[0-9a-f-]{36}/);
    // marker now exists (minted)
    const { existsSync } = await import('fs');
    expect(existsSync(join(cwd, '.memsmith', 'project.json'))).toBe(true);
    // teams/projects upserted
    expect(pool.calls.some((c: any) => /insert into teams/i.test(c.t))).toBe(true);
  });
});
