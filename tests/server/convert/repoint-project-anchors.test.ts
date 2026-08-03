// SPDX-License-Identifier: Apache-2.0
//
// A joined project could READ the team's memory but not WRITE its own.
//
// Every msp_<projectId> database carries its OWN `teams` and `projects` rows —
// seedHinge writes them when the database is provisioned — because the data
// tables FK to projects(id, team_id) *locally*, inside that database. Those are
// not the base database's rows, so repointing the account tables on join left
// them behind, still naming the pre-join team.
//
// The symptom was a WRITE failure, which is why it survived the first round of
// join testing entirely: reads were fixed and verified, and nothing tried to
// insert. The first observation written as the joined teammate failed with
//
//   insert or update on table "observations" violates foreign key constraint
//   "observations_project_id_team_id_fkey"
//   Key (project_id, team_id)=(ec958e91…, 9902d5b8…) is not present in "projects"
//
// because (project, NEW team) had no projects row in that database.
//
// The second bug, found immediately after: the first version of this function
// assumed a fixed child-table list copied from the base-database version, which
// included `audit_log`. audit_log does NOT exist in a project database (account
// tables live in the base database only). In Postgres a statement against a
// missing relation aborts the whole transaction, so the very first scan threw
// and the anchors silently never moved — the function reported nothing because
// it deliberately never throws. It now DISCOVERS which tables exist.
import { describe, it, expect } from 'bun:test';
import { repointProjectDatabaseTeam } from '../../../src/server/convert/repoint-local-key.js';

const TEAM = 'team-owner';
const PROJECT = 'project-joiner';

interface Q { sql: string; params: unknown[] }

/**
 * `tables` is what information_schema reports as present; `rows` maps a table to
 * the ids it holds. A table absent from `tables` must never be queried.
 */
function pool(tables: string[], rows: Record<string, string[]> = {}) {
  const queries: Q[] = [];
  return {
    queries,
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('information_schema.tables')) {
        return { rows: tables.map(id => ({ id })), rowCount: tables.length };
      }
      const m = /SELECT id FROM (\w+)/.exec(sql);
      if (m) {
        const ids = rows[m[1]!] ?? [];
        return { rows: ids.map(id => ({ id })), rowCount: ids.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const ALL = ['agent_events', 'observation_generation_jobs', 'observations', 'server_sessions'];

describe('repointProjectDatabaseTeam', () => {
  it('moves the project anchor row to the joined team', async () => {
    const p = pool(ALL);
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    const move = p.queries.find(q => q.sql.includes('UPDATE projects'))!;
    expect(move).toBeDefined();
    expect(move.params).toEqual([TEAM, PROJECT]);
  });

  it('creates the joined team row locally first', async () => {
    // projects.team_id FKs to teams(id) inside this database too, and a team
    // that lives on someone else's server has no row here.
    const p = pool(ALL);
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    const teamIdx = p.queries.findIndex(q => q.sql.includes('INSERT INTO teams'));
    const moveIdx = p.queries.findIndex(q => q.sql.includes('UPDATE projects'));
    expect(teamIdx).toBeGreaterThan(-1);
    expect(moveIdx).toBeGreaterThan(teamIdx);
  });

  it('NEVER queries a table that does not exist in this database', async () => {
    // THE REGRESSION. audit_log lives in the base database only. Querying it
    // here aborts the transaction, and because this function never throws, the
    // anchors silently stayed on the old team.
    const p = pool(ALL);
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    expect(p.queries.some(q => q.sql.includes('audit_log'))).toBe(false);
    expect(p.queries.some(q => q.sql.includes('api_keys'))).toBe(false);
  });

  it('discovers the child tables rather than assuming a fixed list', async () => {
    // Which tables exist varies with schema version, so the list is queried.
    const p = pool(['observations']);
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    expect(p.queries[0]!.sql).toContain('information_schema.tables');
    // Only the one table it was told exists gets scanned.
    const scans = p.queries.filter(q => /SELECT id FROM \w+ WHERE project_id/.test(q.sql));
    expect(scans).toHaveLength(1);
    expect(scans[0]!.sql).toContain('observations');
  });

  it('runs the table discovery BEFORE opening the transaction', async () => {
    // Inside the transaction a failed lookup would poison every later statement.
    const p = pool(ALL);
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    const discoverIdx = p.queries.findIndex(q => q.sql.includes('information_schema'));
    const beginIdx = p.queries.findIndex(q => q.sql === 'BEGIN');
    expect(discoverIdx).toBeLessThan(beginIdx);
  });

  it('detaches children before moving the project, then re-attaches', async () => {
    // Same non-deferrable composite FK as the base database: the children must
    // let go of the project before it can change team.
    const p = pool(ALL, { observations: ['o1'] });
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    const kinds = p.queries
      .filter(q => q.sql.includes('UPDATE'))
      .map(q => q.sql.includes('project_id = NULL') ? 'detach'
        : q.sql.includes('UPDATE projects') ? 'move'
        : 'reattach');
    expect(kinds).toEqual(['detach', 'move', 'reattach']);
  });

  it('re-attaches by primary key, not by team', async () => {
    const p = pool(ALL, { observations: ['o1', 'o2'] });
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    const reattach = p.queries.find(q => /UPDATE \w+ SET project_id = \$1/.test(q.sql))!;
    expect(reattach.params).toEqual([PROJECT, ['o1', 'o2']]);
  });

  it('commits as one transaction', async () => {
    const p = pool(ALL, { observations: ['o1'] });
    await repointProjectDatabaseTeam(p as never, TEAM, PROJECT);
    expect(p.queries.some(q => q.sql === 'BEGIN')).toBe(true);
    expect(p.queries[p.queries.length - 1]!.sql).toBe('COMMIT');
  });

  it('rolls back and never throws when a write fails', async () => {
    // The remote side of the join is already committed by the time this runs;
    // a local anchor failure must not be reported as a failed join.
    const seen: string[] = [];
    const failing = {
      query: async (sql: string) => {
        seen.push(sql);
        if (sql.includes('information_schema.tables')) return { rows: [{ id: 'observations' }] };
        if (sql.includes('UPDATE projects')) throw new Error('constraint');
        return { rows: [] };
      },
    };
    await repointProjectDatabaseTeam(failing as never, TEAM, PROJECT);
    expect(seen).toContain('ROLLBACK');
    expect(seen).not.toContain('COMMIT');
  });

  it('refuses blank ids without touching the database', async () => {
    const p = pool(ALL);
    await repointProjectDatabaseTeam(p as never, '', PROJECT);
    await repointProjectDatabaseTeam(p as never, TEAM, '');
    expect(p.queries).toHaveLength(0);
  });
});
