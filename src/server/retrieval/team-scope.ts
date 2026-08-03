// SPDX-License-Identifier: Apache-2.0
//
// Team-wide reads: let a project see its TEAMMATES' memory, not just its own.
//
// Until now "team mode" meant a shared backend and a shared team id, but every
// read still returned exactly one project's rows. resolveRequestDatabase routes
// to a single msp_<projectId> database from authContext.projectId, so a joined
// project queried its own — empty — database and saw nothing. Measured live: a
// teammate joined successfully and POST /v1/search returned [].
//
// That is not what "use the team's observations" means, so this widens the READ
// scope to every project in the caller's team.
//
// WHY A UNION AND NOT A SHARED TEAM DATABASE
// The per-project database split (msp_<projectId>) is a deliberate isolation
// boundary: it is what makes a cross-tenant read a physical impossibility rather
// than a WHERE-clause promise. Collapsing the team into one database would undo
// that for a feature that only needs to READ across the boundary. Fanning out
// over the team's databases keeps writes isolated exactly as they are today, and
// keeps the blast radius of a bug here to "reads too little", never "reads
// someone else's team".
//
// THE SECURITY RULE, UNCHANGED
// resolveRequestDatabase's invariant is that the database is chosen from
// authContext ALONE, never from client input. This preserves it: the team comes
// from authContext.teamId, and the project list is derived by asking the account
// database which projects belong to THAT team. A caller cannot name a project,
// a team, or a database. The widening is from "one project in my team" to "all
// projects in my team" — never across teams.

import type { PostgresPool } from '../../storage/postgres/pool.js';
import { projectDatabaseName } from '../runtime/resolve-project-database.js';
import { logger } from '../../utils/logger.js';

/** One readable project in the team. */
export interface TeamProjectTarget {
  projectId: string;
  databaseName: string;
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Every project in `teamId` whose database actually exists.
 *
 * The pg_database EXISTS check mirrors listProjectTargets in
 * multi-project-recovery: a project row can exist before its database has been
 * provisioned (identity is minted at session start, the database on first
 * write), and asking a pool for a non-existent database throws. Filtering here
 * keeps a half-provisioned teammate from failing the whole read.
 *
 * `baseProjectId` is passed through because the cold-boot project lives in the
 * base database rather than an msp_ one, so its name cannot be derived.
 */
export async function listTeamProjects(
  basePool: Queryable,
  teamId: string,
  opts: { baseProjectId?: string | null; baseDatabaseName?: string } = {},
): Promise<TeamProjectTarget[]> {
  if (!teamId?.trim()) return [];
  try {
    const result = await basePool.query(
      `SELECT p.id
         FROM projects p
        WHERE p.team_id = $1
          AND (
            p.id = $2
            OR EXISTS (
              SELECT 1 FROM pg_database d
               WHERE d.datname = 'msp_' || replace(p.id::text, '-', '')
            )
          )`,
      [teamId, opts.baseProjectId ?? null],
    );
    return (result.rows as Array<{ id?: unknown }>)
      .map(r => String(r.id ?? ''))
      .filter(Boolean)
      .map(projectId => ({
        projectId,
        databaseName: projectId === opts.baseProjectId && opts.baseDatabaseName
          ? opts.baseDatabaseName
          : projectDatabaseName(projectId),
      }));
  } catch (error) {
    // Degrade to "just my own project" rather than failing the read. A search
    // that returns the caller's own memory is a smaller failure than a search
    // that errors, and the caller's own rows are always reachable.
    logger.warn('SEARCH', 'listTeamProjects failed; falling back to own project',
      { teamId }, error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}

/**
 * Run `read` against every project in the team and merge the results.
 *
 * Per-project failures are swallowed deliberately: one teammate's unreachable or
 * mid-migration database must not blank out everyone else's memory. The failure
 * is logged and that project contributes nothing.
 */
export async function readAcrossTeam<T>(
  targets: TeamProjectTarget[],
  poolFor: (databaseName: string, projectId: string) => Promise<PostgresPool>,
  read: (pool: PostgresPool, projectId: string) => Promise<T[]>,
): Promise<T[]> {
  const settled = await Promise.all(targets.map(async t => {
    try {
      const pool = await poolFor(t.databaseName, t.projectId);
      return await read(pool, t.projectId);
    } catch (error) {
      logger.warn('SEARCH', 'team read skipped a project',
        { projectId: t.projectId }, error instanceof Error ? error : new Error(String(error)));
      return [] as T[];
    }
  }));
  return settled.flat();
}

/**
 * Order merged rows the way a single-project read would, then cut to `limit`.
 *
 * Each project's read already applied `limit`, so the union can hold up to
 * N*limit rows; without a re-sort the caller would get "the first project's
 * newest, then the second's", which is not a recency ordering at all.
 *
 * `rank` is ascending-best (search relevance position). When present it wins,
 * because for a query the point is the best matches across the team — recency
 * is the browse ordering, not the search ordering.
 */
export function mergeTeamResults<T extends { createdAtEpoch?: number }>(
  rows: T[],
  limit: number,
  rank?: (row: T) => number,
): T[] {
  const sorted = [...rows].sort((a, b) => {
    if (rank) {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
    }
    return (b.createdAtEpoch ?? 0) - (a.createdAtEpoch ?? 0);
  });
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}
