// SPDX-License-Identifier: Apache-2.0
//
// Team-wide reads. A joined project must see its TEAMMATES' memory.
//
// Before this, "team mode" meant a shared team id and (optionally) a shared
// backend, but every read still hit exactly one msp_<projectId> database. A
// teammate who joined successfully ran POST /v1/search and got [] — measured
// live. Their own database was empty; the memory was in the owner's.
//
// The security invariant these tests exist to protect: the read scope is derived
// from authContext ALONE. The caller supplies no project, no team, no database
// name. Widening goes from "one project in my team" to "all projects in my
// team" — never across teams. If a future change lets client input reach the
// project list, the cross-tenant tests below fail.
import { describe, it, expect } from 'bun:test';
import {
  listTeamProjects,
  readAcrossTeam,
  mergeTeamResults,
} from '../../../src/server/retrieval/team-scope.js';

const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';

function basePool(rows: Array<{ id: string }>, capture?: { sql?: string; params?: unknown[] }) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (capture) { capture.sql = sql; capture.params = params; }
      return { rows };
    },
  };
}

describe('listTeamProjects', () => {
  it('returns every project in the team, mapped to its database', async () => {
    const targets = await listTeamProjects(
      basePool([{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }, { id: 'bbbbbbbb-0000-0000-0000-000000000002' }]),
      TEAM,
    );
    expect(targets).toHaveLength(2);
    expect(targets[0]!.databaseName).toBe('msp_aaaaaaaa000000000000000000000001');
    expect(targets[1]!.databaseName).toBe('msp_bbbbbbbb000000000000000000000002');
  });

  it('filters ON THE TEAM, and takes the team only from its argument', async () => {
    // THE SECURITY TEST. The team is a parameter the route fills from
    // authContext; nothing here reads a request. If the WHERE clause ever stops
    // constraining team_id, a caller in team-1 could read team-2.
    const cap: { sql?: string; params?: unknown[] } = {};
    await listTeamProjects(basePool([], cap), TEAM);
    expect(cap.sql).toContain('WHERE p.team_id = $1');
    expect(cap.params?.[0]).toBe(TEAM);
  });

  it('never returns a project belonging to another team', async () => {
    // The query is what enforces this; the fake pool honours the filter so the
    // assertion is about the contract, not the fake.
    const pool = {
      query: async (_sql: string, params?: unknown[]) => ({
        rows: params?.[0] === TEAM ? [{ id: 'aaaaaaaa-0000-0000-0000-000000000001' }] : [],
      }),
    };
    expect(await listTeamProjects(pool, TEAM)).toHaveLength(1);
    expect(await listTeamProjects(pool, OTHER_TEAM)).toHaveLength(0);
  });

  it('skips projects whose database does not exist yet', async () => {
    // Identity is minted at session start but the database only on first write,
    // so a teammate can have a projects row and no msp_ database. Asking a pool
    // for a missing database throws, which would fail the whole read.
    const cap: { sql?: string; params?: unknown[] } = {};
    await listTeamProjects(basePool([], cap), TEAM);
    expect(cap.sql).toContain('pg_database');
  });

  it('includes the base project, whose database is not an msp_ one', async () => {
    // The cold-boot/dogfood project lives in the base database, so its name
    // cannot be derived from the id.
    const base = 'cccccccc-0000-0000-0000-000000000003';
    const targets = await listTeamProjects(basePool([{ id: base }]), TEAM, {
      baseProjectId: base,
      baseDatabaseName: 'postgres',
    });
    expect(targets[0]!.databaseName).toBe('postgres');
  });

  it('returns empty for a blank team rather than querying', async () => {
    let queried = false;
    await listTeamProjects({ query: async () => { queried = true; return { rows: [] }; } }, '');
    expect(queried).toBe(false);
  });

  it('degrades to empty when the account query fails', async () => {
    // Falling back to "just my own project" is a smaller failure than a search
    // that errors — the caller's own rows stay reachable either way.
    const out = await listTeamProjects({ query: async () => { throw new Error('db down'); } }, TEAM);
    expect(out).toEqual([]);
  });
});

describe('readAcrossTeam', () => {
  const targets = [
    { projectId: 'p1', databaseName: 'msp_1' },
    { projectId: 'p2', databaseName: 'msp_2' },
  ];

  it('merges rows from every project in the team', async () => {
    const rows = await readAcrossTeam(
      targets,
      async () => ({}) as never,
      async (_pool, projectId) => [`${projectId}-a`, `${projectId}-b`],
    );
    expect(rows.sort()).toEqual(['p1-a', 'p1-b', 'p2-a', 'p2-b']);
  });

  it('opens each project against ITS OWN database', async () => {
    const opened: string[] = [];
    await readAcrossTeam(
      targets,
      async (databaseName) => { opened.push(databaseName); return {} as never; },
      async () => [],
    );
    expect(opened.sort()).toEqual(['msp_1', 'msp_2']);
  });

  it('keeps going when ONE project fails', async () => {
    // A teammate mid-migration or with an unreachable database must not blank
    // out everyone else's memory.
    const rows = await readAcrossTeam(
      targets,
      async () => ({}) as never,
      async (_pool, projectId) => {
        if (projectId === 'p1') throw new Error('unreachable');
        return ['p2-a'];
      },
    );
    expect(rows).toEqual(['p2-a']);
  });

  it('survives a pool that cannot be opened at all', async () => {
    const rows = await readAcrossTeam(
      targets,
      async (db) => { if (db === 'msp_1') throw new Error('no such database'); return {} as never; },
      async () => ['ok'],
    );
    expect(rows).toEqual(['ok']);
  });

  it('returns empty for no targets without calling the reader', async () => {
    let called = false;
    const rows = await readAcrossTeam([], async () => ({}) as never, async () => { called = true; return ['x']; });
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('mergeTeamResults', () => {
  const rows = [
    { id: 'old', createdAtEpoch: 100 },
    { id: 'new', createdAtEpoch: 300 },
    { id: 'mid', createdAtEpoch: 200 },
  ];

  it('re-sorts by recency across projects', async () => {
    // Each project applied `limit` itself, so the union arrives grouped by
    // project. Without a re-sort the caller gets "project A's newest, then
    // project B's", which is not a recency ordering at all.
    expect(mergeTeamResults(rows, 10).map(r => r.id)).toEqual(['new', 'mid', 'old']);
  });

  it('cuts to the requested limit AFTER merging', async () => {
    // Cutting before the merge would drop a teammate's newer row in favour of
    // an older local one.
    expect(mergeTeamResults(rows, 2).map(r => r.id)).toEqual(['new', 'mid']);
  });

  it('prefers rank over recency when ranking a query', async () => {
    // For a search the point is the best matches across the team; recency is
    // the browse ordering, not the search ordering.
    const ranked = [
      { id: 'a', createdAtEpoch: 300, r: 2 },
      { id: 'b', createdAtEpoch: 100, r: 1 },
    ];
    expect(mergeTeamResults(ranked, 10, x => x.r).map(x => x.id)).toEqual(['b', 'a']);
  });

  it('falls back to recency when ranks tie', async () => {
    const tied = [
      { id: 'older', createdAtEpoch: 100, r: 1 },
      { id: 'newer', createdAtEpoch: 200, r: 1 },
    ];
    expect(mergeTeamResults(tied, 10, x => x.r).map(x => x.id)).toEqual(['newer', 'older']);
  });

  it('does not mutate the input array', async () => {
    const input = [...rows];
    mergeTeamResults(input, 1);
    expect(input.map(r => r.id)).toEqual(['old', 'new', 'mid']);
  });

  it('treats a non-positive limit as no limit', async () => {
    expect(mergeTeamResults(rows, 0)).toHaveLength(3);
  });
});
