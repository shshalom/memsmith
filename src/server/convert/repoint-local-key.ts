// SPDX-License-Identifier: Apache-2.0
//
// The last step of a JOIN: re-point this project's LOCAL api_keys row at the
// team it just joined.
//
// A join changes which team a project belongs to. That fact has to land in four
// places, and it was landing in three:
//
//   1. the project marker            (writeProjectRuntime, teamId + runtime)
//   2. the CredentialStore           (storeKeyForTeam, under the NEW team)
//   3. the remote's projects table   (upsertTeamAndProject via runJoin)
//   4. the LOCAL api_keys row        <- missed
//
// postgres-auth builds authContext.teamId straight from that api_keys row, and
// every scoped read filters on it. So after a join that looked completely
// successful, the joiner authenticated as its OLD self against its OLD team:
// /v1/identity reported runtime "team" with the stale teamId, and /v1/search
// returned zero observations even though the remote held the team's memory.
//
// Measured live after a real join (rig, owner team 9902d5b8):
//   marker          -> 9902d5b8, runtime "server"   OK
//   CredentialStore -> key under 9902d5b8           OK
//   remote projects -> joiner under 9902d5b8        OK
//   LOCAL api_keys  -> team_id d51b7678 (OLD)       <- read scope followed THIS
//
// Deliberately NOT a team-wide update: it moves exactly the one project being
// joined. In local mode every project mints its own randomUUID team, so two
// projects sharing a team means someone grouped them on purpose — not something
// a join of one of them should rewrite.

import { logger } from '../../utils/logger.js';

interface QueryablePool {
  query: (sql: string, params: unknown[]) => Promise<{
    rowCount?: number | null;
    rows?: Array<{ id: string }>;
  }>;
}

/**
 * Move the FK anchor rows INSIDE a project's own database to the joined team.
 *
 * Every msp_<projectId> database carries its own `teams` and `projects` rows —
 * seedHinge writes them at provision time — because the data tables FK to
 * projects(id, team_id) locally. Those anchors are NOT the base database's rows,
 * so repointing the account tables leaves them behind, still naming the old team.
 *
 * The symptom is a write failure, not a read failure, which is why it survived
 * the first round of join testing: reads worked, and the first attempt to insert
 * an observation as the joined teammate failed with
 *   "insert or update on table observations violates foreign key constraint
 *    observations_project_id_team_id_fkey"
 * because (project, NEW team) had no projects row in that database.
 *
 * Same detach/move/re-attach dance as the base database, and for the same
 * reason: the composite FK is not deferrable, so the children have to let go of
 * the project before it can move.
 *
 * Never throws — see repointLocalKeyToTeam.
 */
export async function repointProjectDatabaseTeam(
  pool: QueryablePool,
  teamId: string,
  projectId: string,
): Promise<void> {
  if (!teamId?.trim() || !projectId?.trim()) return;
  // A project database holds only the DATA tables — account tables (api_keys,
  // team_members, audit_log) live in the base database. Which tables exist also
  // varies with schema version, and a SELECT against a missing one aborts the
  // whole transaction in Postgres (every later statement fails with "current
  // transaction is aborted"). That is exactly how the first version of this
  // silently did nothing: audit_log does not exist here, so the very first scan
  // threw and the anchors never moved. Discover the list instead of assuming it.
  const present = await pool.query(
    `SELECT table_name AS id FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [['agent_events', 'observation_generation_jobs', 'observations', 'server_sessions']],
  );
  const CHILD_TABLES = (present.rows ?? []).map(r => r.id);
  try {
    await pool.query('BEGIN', []);
    try {
      await pool.query(
        `INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
        [teamId],
      );
      const detached: Array<{ table: string; ids: string[] }> = [];
      for (const table of CHILD_TABLES) {
        const found = await pool.query(`SELECT id FROM ${table} WHERE project_id = $1`, [projectId]);
        const ids = (found.rows ?? []).map(r => r.id);
        if (!ids.length) continue;
        detached.push({ table, ids });
        await pool.query(
          `UPDATE ${table} SET project_id = NULL, team_id = $1 WHERE id = ANY($2::text[])`,
          [teamId, ids],
        );
      }
      await pool.query(
        'UPDATE projects SET team_id = $1, updated_at = now() WHERE id = $2',
        [teamId, projectId],
      );
      for (const { table, ids } of detached) {
        await pool.query(
          `UPDATE ${table} SET project_id = $1 WHERE id = ANY($2::text[])`,
          [projectId, ids],
        );
      }
      await pool.query('COMMIT', []);
    } catch (inner) {
      await pool.query('ROLLBACK', []).catch(() => {});
      throw inner;
    }
    logger.info('IDENTITY', 'repointed project database anchors to joined team', { teamId, projectId });
  } catch (error) {
    logger.warn('IDENTITY', 'could not repoint project database anchors', { teamId, projectId },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Point the given project's local API key at `teamId`.
 *
 * Never throws: by the time this runs the remote side of the join is already
 * committed, so a local bookkeeping failure must not be reported to the user as
 * a failed join. It is recoverable on the project's next session.
 */
export async function repointLocalKeyToTeam(
  pool: QueryablePool,
  teamId: string,
  projectId: string,
): Promise<void> {
  // Guard both ids. An empty teamId would NULL the column — and a NULL team_id
  // makes authContext.role unresolvable, which is exactly what once made
  // requireRole('owner') unsatisfiable on every local install. An empty
  // projectId would turn this into an unscoped UPDATE across every row.
  if (!teamId?.trim() || !projectId?.trim()) {
    logger.warn('IDENTITY', 'refusing to repoint local key: missing team or project', { teamId, projectId });
    return;
  }
  try {
    // THE TWO ROWS MUST MOVE TOGETHER. api_keys carries a COMPOSITE foreign key:
    //
    //   api_keys_project_id_team_id_fkey  (project_id, team_id) -> projects(id, team_id)
    //
    // which makes NEITHER order work on its own — both were tried live:
    //
    //   key first     -> "insert or update on table \"api_keys\" violates foreign
    //                     key constraint api_keys_project_id_team_id_fkey"
    //                    (no projects row yet names the new pair)
    //   project first -> "update or delete on table \"projects\" violates foreign
    //                     key constraint api_keys_project_id_team_id_fkey on
    //                     table \"api_keys\""
    //                    (the existing key still references the OLD pair)
    //
    // The constraint is NOT DEFERRABLE (verified: condeferrable = false), so
    // SET CONSTRAINTS ... DEFERRED is unavailable. Instead the key is detached
    // from the project for the duration of the move:
    //
    //   project_id = NULL  ->  project's team moves  ->  project_id restored
    //
    // NULLing project_id is legal by design — api_keys_check is
    // "project_id IS NULL OR team_id IS NOT NULL", i.e. a team-scoped key with no
    // project is a supported shape (that is what a team-wide key is). With no
    // project_id the composite FK has nothing to check, so the project row is
    // free to move.
    //
    // All of it in ONE transaction: a crash mid-way would otherwise leave the key
    // permanently detached, and authContext.projectId comes from that column —
    // resolveRequestDatabase 400s "no project identity" without it, so the
    // project would authenticate but fail every read.
    //
    // Both earlier failures were invisible in normal use: this function never
    // throws, so the join reported success while the joiner kept reading its old,
    // empty scope. They were found only by reading the server log.
    await pool.query('BEGIN', []);
    try {
      // The joined team must exist locally — projects.team_id FKs to teams(id),
      // and a team living on someone else's server has no local row. Named after
      // its id, matching upsertTeamAndProject: this is a local mirror, not a new
      // team, so there is no name to import.
      await pool.query(
        `INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
        [teamId],
      );
      // SIX tables carry the same composite FK to projects(id, team_id), all
      // NOT DEFERRABLE:
      //   agent_events, api_keys, audit_log, observation_generation_jobs,
      //   observations, server_sessions
      // (verified by querying pg_constraint for confrelid = 'projects'). Every one
      // of them pins the project to its CURRENT team, so the project row cannot
      // move while any child still names the old pair. Moving one child at a time
      // just surfaces the next table's constraint — which is how this was found:
      // fixing api_keys revealed audit_log.
      //
      // So the children are detached from the project FIRST (project_id = NULL
      // drops the composite FK's subject), the project moves, then they are
      // re-attached. All inside the transaction opened above: a crash between the
      // detach and the re-attach would orphan real rows.
      //
      // NOTE the local base DB legitimately holds team-scoped keys with
      // project_id IS NULL, so a blanket re-attach by team would capture rows that
      // were never ours. Each child is therefore restored by PRIMARY KEY, captured
      // before the detach.
      const CHILD_TABLES = [
        'agent_events', 'api_keys', 'audit_log',
        'observation_generation_jobs', 'observations', 'server_sessions',
      ] as const;

      const detached: Array<{ table: string; ids: string[] }> = [];
      for (const table of CHILD_TABLES) {
        const found = await pool.query(
          `SELECT id FROM ${table} WHERE project_id = $1`,
          [projectId],
        );
        const ids = (found.rows ?? []).map(r => r.id);
        if (!ids.length) continue;
        detached.push({ table, ids });
        // team_id moves now too, so the re-attach below lands on the new pair.
        await pool.query(
          `UPDATE ${table} SET project_id = NULL, team_id = $1 WHERE id = ANY($2::text[])`,
          [teamId, ids],
        );
      }

      await pool.query(
        'UPDATE projects SET team_id = $1, updated_at = now() WHERE id = $2',
        [teamId, projectId],
      );

      // Re-attach by primary key. Both sides now name the new team, so every
      // composite FK holds. key_hash is untouched throughout: the credential does
      // not change, only which team it speaks for — rewriting it would invalidate
      // the cached plaintext and lock the project out.
      for (const { table, ids } of detached) {
        await pool.query(
          `UPDATE ${table} SET project_id = $1 WHERE id = ANY($2::text[])`,
          [projectId, ids],
        );
      }
      await pool.query('COMMIT', []);
    } catch (inner) {
      await pool.query('ROLLBACK', []).catch(() => {});
      throw inner;
    }
    logger.info('IDENTITY', 'repointed local api key to joined team', { teamId, projectId });
  } catch (error) {
    logger.warn('IDENTITY', 'could not repoint local api key to joined team', { teamId, projectId },
      error instanceof Error ? error : new Error(String(error)));
  }
}
