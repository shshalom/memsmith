// SPDX-License-Identifier: Apache-2.0
//
// After a join, the joiner must be able to READ the team's memory. It could not.
//
// A successful live join (against the rig, with the three earlier fixes in
// place) left the project correct everywhere except one row:
//
//   marker            teamId 9902d5b8 (owner's), runtime "server"   OK
//   CredentialStore   team key cached under 9902d5b8                OK
//   remote projects   joiner registered under 9902d5b8              OK
//   LOCAL api_keys    project ec958e91 -> team_id d51b7678 (OLD)    <- the hole
//
// /v1/identity reported runtime "team" but teamId d51b7678, and POST /v1/search
// returned {"observations":[]} — the joiner could not see the owner's three
// observations even though the remote showed both projects under the owner's team.
//
// WHY: postgres-auth builds authContext.teamId directly from the api_keys row
// ("teamId / projectId on req.authContext come straight from the Postgres row").
// Every scoped read is then filtered by that teamId. The dashboard's loopback
// cookie carries the LOCAL base key, so the joiner authenticated as its old self
// against its old team and read its own — empty — scope.
//
// This is the "server-wide vs per-project" family again: join updated the marker,
// the credential store, and the remote, but not the local row that authContext is
// derived from. Three of the four places agreed; the fourth silently won.
//
// The fix re-points that project's local api_keys row at the new team. Scoped to
// the ONE project being joined: a team-wide UPDATE would move every project that
// happened to share the old team, and in local mode each project gets its own
// randomUUID team, so a shared old team means someone deliberately grouped them.
import { describe, it, expect } from 'bun:test';
import { repointLocalKeyToTeam } from '../../../src/server/convert/repoint-local-key.js';

interface Q { sql: string; params: unknown[] }

/**
 * `childRows` maps a child table name to the row ids it holds for the project,
 * so the detach/re-attach sequence can be observed. A table absent from the map
 * returns no rows and must therefore be skipped entirely.
 */
function pool(childRows: Record<string, string[]> = {}) {
  const queries: Q[] = [];
  return {
    queries,
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      const m = /SELECT id FROM (\w+)/.exec(sql);
      if (m) {
        const ids = childRows[m[1]!] ?? [];
        return { rows: ids.map(id => ({ id })), rowCount: ids.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

/** Classify a statement for order assertions. */
function kindOf(sql: string): string {
  if (sql === 'BEGIN') return 'begin';
  if (sql === 'COMMIT') return 'commit';
  if (sql === 'ROLLBACK') return 'rollback';
  if (sql.includes('INSERT INTO teams')) return 'team';
  if (sql.includes('SELECT id FROM')) return 'scan';
  if (sql.includes('project_id = NULL')) return 'detach';
  if (sql.includes('UPDATE projects')) return 'move-project';
  if (/UPDATE \w+ SET project_id = \$1/.test(sql)) return 'reattach';
  return 'other';
}

const PROJECT = 'project-1';
const NEW_TEAM = 'team-owner';

describe('repointLocalKeyToTeam', () => {
  it('moves both the project and its api_keys row to the new team', async () => {
    const p = pool({ api_keys: ['k1'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    expect(p.queries.some(q => q.sql.includes('UPDATE projects'))).toBe(true);
    expect(p.queries.some(q => kindOf(q.sql) === 'detach')).toBe(true);
    expect(p.queries.some(q => kindOf(q.sql) === 'reattach')).toBe(true);
  });

  it('detaches children BEFORE moving the project, then re-attaches', async () => {
    // FORCED BY THE SCHEMA. Six tables carry the same NOT-DEFERRABLE composite FK
    // to projects(id, team_id): agent_events, api_keys, audit_log,
    // observation_generation_jobs, observations, server_sessions. Each pins the
    // project to its CURRENT team, so neither naive order works — both were tried
    // against the live DB:
    //
    //   key first     -> 'insert or update on table "api_keys" violates ...
    //                     api_keys_project_id_team_id_fkey'
    //   project first -> 'update or delete on table "projects" violates ...
    //                     api_keys_project_id_team_id_fkey on table "api_keys"'
    //                    then, once api_keys was handled, the SAME error for
    //                    audit_log — one table at a time, forever.
    //
    // Detaching every child first (project_id = NULL removes the composite FK's
    // subject), moving the project, then re-attaching is the only sequence that
    // satisfies all six at once.
    const p = pool({ api_keys: ['k1'], audit_log: ['a1', 'a2'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const kinds = p.queries.map(q => kindOf(q.sql)).filter(k => k !== 'scan');
    const lastDetach = kinds.lastIndexOf('detach');
    const move = kinds.indexOf('move-project');
    const firstReattach = kinds.indexOf('reattach');
    expect(lastDetach).toBeGreaterThan(-1);
    expect(move).toBeGreaterThan(lastDetach);
    expect(firstReattach).toBeGreaterThan(move);
  });

  it('wraps the whole move in one transaction', async () => {
    // A crash between the detach and the re-attach would orphan real rows, and
    // authContext.projectId comes from api_keys.project_id — resolveRequestDatabase
    // 400s "no project identity" without it, so the project would authenticate
    // but fail every read.
    const p = pool({ api_keys: ['k1'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const kinds = p.queries.map(q => kindOf(q.sql));
    expect(kinds[0]).toBe('begin');
    expect(kinds[kinds.length - 1]).toBe('commit');
  });

  it('rolls back when a write fails, leaving nothing half-moved', async () => {
    let n = 0;
    const rolled: string[] = [];
    const failing = {
      query: async (sql: string) => {
        rolled.push(sql);
        n += 1;
        if (sql.includes('UPDATE projects')) throw new Error('constraint');
        if (/SELECT id FROM/.test(sql)) return { rows: [{ id: 'k1' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    await repointLocalKeyToTeam(failing as never, NEW_TEAM, PROJECT);
    expect(rolled).toContain('ROLLBACK');
    expect(rolled).not.toContain('COMMIT');
    expect(n).toBeGreaterThan(0);
  });

  it('skips tables that hold no rows for the project', async () => {
    // Only audit_log has rows in the measured case; issuing pointless UPDATEs
    // against the other five would be needless write traffic on every join.
    const p = pool({ audit_log: ['a1'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const detaches = p.queries.filter(q => kindOf(q.sql) === 'detach');
    expect(detaches).toHaveLength(1);
    expect(detaches[0]!.sql).toContain('audit_log');
  });

  it('re-attaches by PRIMARY KEY, never by team', async () => {
    // The local base DB legitimately holds team-scoped keys with project_id IS
    // NULL (measured: 5 of them). A blanket "re-attach every null-project row for
    // this team" would capture rows that were never ours.
    const p = pool({ api_keys: ['k1'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const reattach = p.queries.find(q => kindOf(q.sql) === 'reattach')!;
    expect(reattach.sql).toContain('WHERE id = ANY');
    expect(reattach.params).toEqual([PROJECT, ['k1']]);
  });

  it('creates the joined team locally if absent, without clobbering an existing one', async () => {
    // The local base DB has no row for a team that lives on someone else's
    // server, and projects.team_id FKs to teams(id). ON CONFLICT DO NOTHING so a
    // team already known locally keeps its name.
    const p = pool();
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const teamInsert = p.queries.find(q => kindOf(q.sql) === 'team')!;
    expect(teamInsert.sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(teamInsert.params).toEqual([NEW_TEAM]);
  });

  it('scopes the project move to that project ONLY', async () => {
    // A team-wide update would drag along every other project sharing the old
    // team. In local mode each project mints its own randomUUID team, so a
    // shared team is deliberate grouping — not ours to rewrite.
    const p = pool();
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    const move = p.queries.find(q => kindOf(q.sql) === 'move-project')!;
    expect(move.sql).toContain('WHERE id = $2');
    expect(move.params).toEqual([NEW_TEAM, PROJECT]);
  });

  it('does not touch the key hash — the credential itself is unchanged', async () => {
    // Only the team pointer moves. Rewriting key_hash would invalidate the
    // cached plaintext and lock the project out entirely.
    const p = pool({ api_keys: ['k1'] });
    await repointLocalKeyToTeam(p as never, NEW_TEAM, PROJECT);
    for (const q of p.queries) expect(q.sql).not.toContain('key_hash');
  });

  it('refuses an empty team id rather than NULLing the row', async () => {
    // A NULL team_id makes authContext.role unresolvable, which is what made
    // requireRole('owner') unsatisfiable on every local install once before.
    const p = pool();
    await repointLocalKeyToTeam(p as never, '', PROJECT);
    expect(p.queries).toHaveLength(0);
  });

  it('refuses an empty project id rather than updating every row', async () => {
    // Without the project filter this becomes an unscoped UPDATE.
    const p = pool();
    await repointLocalKeyToTeam(p as never, NEW_TEAM, '');
    expect(p.queries).toHaveLength(0);
  });

  it('never throws — a join that already succeeded must not report failure', async () => {
    // The remote side of the join is already committed by this point. A local
    // bookkeeping failure is recoverable on the next session; turning it into an
    // exception would tell the user the join failed when it did not.
    const throwing = { query: async () => { throw new Error('db down'); } };
    await expect(repointLocalKeyToTeam(throwing as never, NEW_TEAM, PROJECT)).resolves.toBeUndefined();
  });
});

describe('the join path actually calls it', () => {
  // A source guard: the unit tests above prove the helper is correct, not that
  // anything uses it. The bug being fixed was precisely a correct mechanism
  // that no caller invoked (ensureBaseKey, one layer earlier in this same join).
  const ROUTE = 'src/server/routes/v1/ServerV1PostgresRoutes.ts';

  it('repoints the local key inside the join success branch', async () => {
    const src = await Bun.file(ROUTE).text();
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).toContain('repointLocalKeyToTeam');
    // Inside the join dep, not merely imported.
    const joinDepStart = code.indexOf('join: async (input)');
    expect(joinDepStart).toBeGreaterThan(-1);
    const afterJoinDep = code.slice(joinDepStart);
    expect(afterJoinDep.indexOf('repointLocalKeyToTeam')).toBeGreaterThan(-1);
  });
});
