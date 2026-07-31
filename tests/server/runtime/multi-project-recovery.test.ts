// SPDX-License-Identifier: Apache-2.0
//
// Recovery must cover EVERY project database, not just the base one.
//
// The stranding fixes each take a single pool, and startup passed them the BASE
// pool. When projects moved to per-project `msp_<id>` databases, all of them
// silently became partial: they still ran, still logged success, and covered
// only the dogfood. Every other project stranded in total silence.
//
// Measured on a fresh install (ms-p3-run2): 26 agent_events captured, 27 jobs
// created, 1 completed, 26 stuck 'queued' with no code path able to see them.
// The only observations that appeared were a memory_gap and a user_note — both
// DIRECT inserts that bypass generation — which is why it looked half-working
// rather than broken.
//
// Worse than the bug it descends from: that was a one-time backlog, this hits
// every project created from now on.
import { describe, it, expect } from 'bun:test';
import {
  listProjectTargets,
  sweepAllProjects,
  projectDatabaseNameFor,
  type ProjectTarget,
  type RecoveryQueryable,
} from '../../../src/server/runtime/multi-project-recovery.js';

function fakeBasePool(rows: Array<{ id: string; team_id: string }>): RecoveryQueryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(text: string) {
      calls.push(text);
      return { rows };
    },
  };
}

const T = (projectId: string, teamId = 'team-1'): ProjectTarget =>
  ({ projectId, teamId, databaseName: projectDatabaseNameFor(projectId) });

describe('projectDatabaseNameFor', () => {
  it('matches the msp_<hex> convention used by projectDatabaseName', () => {
    expect(projectDatabaseNameFor('74bd6864-0d86-4914-b7f9-cce14e00193c'))
      .toBe('msp_74bd68640d864914b7f9cce14e00193c');
  });
});

describe('listProjectTargets', () => {
  it('returns every project whose database exists', async () => {
    const pool = fakeBasePool([
      { id: 'aaaaaaaa-0000-0000-0000-000000000001', team_id: 'team-1' },
      { id: 'bbbbbbbb-0000-0000-0000-000000000002', team_id: 'team-2' },
    ]);
    const targets = await listProjectTargets(pool);
    expect(targets).toHaveLength(2);
    expect(targets[0]!.databaseName).toBe('msp_aaaaaaaa00000000000000000000000' + '1');
  });

  it('only considers projects whose msp_ database actually exists', async () => {
    // A project row can exist before its database is provisioned. Connecting to
    // a missing database throws, which would abort the sweep partway and leave
    // later projects unrecovered — the same silent partial coverage, new shape.
    const pool = fakeBasePool([]);
    await listProjectTargets(pool);
    expect(pool.calls[0]).toMatch(/pg_database/);
  });

  it('EXCLUDES the base project, whose rows live in the base database', async () => {
    // Including it would double-process the dogfood on every startup.
    const base = 'aaaaaaaa-0000-0000-0000-000000000001';
    const pool = fakeBasePool([
      { id: base, team_id: 'team-1' },
      { id: 'bbbbbbbb-0000-0000-0000-000000000002', team_id: 'team-2' },
    ]);
    const targets = await listProjectTargets(pool, { baseProjectId: base });
    expect(targets.map(t => t.projectId)).toEqual(['bbbbbbbb-0000-0000-0000-000000000002']);
  });

  it('drops rows with a missing id or teamId rather than building a bad DSN', async () => {
    const pool = fakeBasePool([{ id: '', team_id: 'team-1' }, { id: 'x', team_id: '' }]);
    expect(await listProjectTargets(pool)).toEqual([]);
  });

  it('returns [] instead of throwing when the base query fails', async () => {
    const pool: RecoveryQueryable = { query: async () => { throw new Error('pg down'); } };
    expect(await listProjectTargets(pool)).toEqual([]);
  });
});

describe('sweepAllProjects', () => {
  it('runs the sweep against EVERY project', async () => {
    const seen: string[] = [];
    const result = await sweepAllProjects([T('p1'), T('p2'), T('p3')], {
      getPool: async () => ({ query: async () => ({ rows: [] }) }),
      sweep: async (_pool, target) => { seen.push(target.projectId); return 2; },
    });
    expect(seen).toEqual(['p1', 'p2', 'p3']);
    expect(result.total).toBe(6);
    expect(result.projectsSwept).toBe(3);
  });

  it('one unreachable database does not stop the others', async () => {
    // The failure being fixed IS silent partial coverage. A sweep that aborts
    // halfway would reproduce it, so isolation per project is the point.
    const seen: string[] = [];
    const result = await sweepAllProjects([T('p1'), T('p2'), T('p3')], {
      getPool: async (t) => (t.projectId === 'p2' ? null : { query: async () => ({ rows: [] }) }),
      sweep: async (_pool, target) => { seen.push(target.projectId); return 1; },
    });
    expect(seen).toEqual(['p1', 'p3']);
    expect(result.projectsSwept).toBe(2);
    expect(result.projectsFailed).toBe(1);
  });

  it('one THROWING sweep does not stop the others', async () => {
    const seen: string[] = [];
    const result = await sweepAllProjects([T('p1'), T('p2'), T('p3')], {
      getPool: async () => ({ query: async () => ({ rows: [] }) }),
      sweep: async (_pool, target) => {
        if (target.projectId === 'p2') throw new Error('boom');
        seen.push(target.projectId);
        return 1;
      },
    });
    expect(seen).toEqual(['p1', 'p3']);
    expect(result.projectsFailed).toBe(1);
  });

  it('never throws even when every project fails', async () => {
    const result = await sweepAllProjects([T('p1'), T('p2')], {
      getPool: async () => { throw new Error('nope'); },
      sweep: async () => 0,
    });
    expect(result).toEqual({ total: 0, projectsSwept: 0, projectsFailed: 2 });
  });

  it('reports progress only for projects that actually recovered something', async () => {
    const progress: string[] = [];
    await sweepAllProjects([T('p1'), T('p2')], {
      getPool: async () => ({ query: async () => ({ rows: [] }) }),
      sweep: async (_p, t) => (t.projectId === 'p1' ? 5 : 0),
      onProgress: ({ target }) => progress.push(target.projectId),
    });
    // Silence on a no-op keeps the startup log meaningful; the original bug was
    // recovery that logged success while doing nothing.
    expect(progress).toEqual(['p1']);
  });

  it('handles an empty target list without work', async () => {
    let called = false;
    const result = await sweepAllProjects([], {
      getPool: async () => { called = true; return null; },
      sweep: async () => 0,
    });
    expect(called).toBe(false);
    expect(result.projectsSwept).toBe(0);
  });
});
