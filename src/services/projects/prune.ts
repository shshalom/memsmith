// SPDX-License-Identifier: Apache-2.0
//
// A database is dropped only when a count of every row in every table shows
// nothing but its own project's hinge rows (or, for a merged project, nothing
// newer than the merge), and no other project names it. Anything MemSmith
// cannot count or cannot rule out is kept, with the reason.
import { join } from 'path';
import { backupFileName, writeBackupFile, type DumpDatabase } from './backup.js';
import { knownEmpty, recordTotal, type ProjectEntry, type ProjectInventory } from './inventory.js';
import type { DatabaseCensus, ProjectsDb } from './projects-db.js';

export type PruneReason = 'orphan-db' | 'empty' | 'archived';

export interface PruneCandidate {
  entry: ProjectEntry;
  reason: PruneReason;
  /** Database to back up and drop; null when the project has none. */
  dropDatabase: string | null;
  /** Delete the projects row. A merged project keeps its row, so folders that still name it are routed to its target. */
  deleteProject: boolean;
}

export interface PruneKept {
  entry: ProjectEntry;
  reason: string;
}

export interface PrunePlan {
  candidates: PruneCandidate[];
  kept: PruneKept[];
  /** Every database a project entry names, with the entries that name it. */
  databaseOwners: Map<string, Array<string | null>>;
}

export const DROPPABLE_DATABASE = /^msp_[0-9a-f]{32}$/;

export type Census = (databaseName: string, owner: { projectId: string; teamId: string } | 'from-name') => Promise<DatabaseCensus | null>;

/** Why a census rules out dropping the database, or null when it allows it. */
function censusBlocks(census: DatabaseCensus | null, allowData: { archivedAt: string } | null): string | null {
  if (!census) return 'MemSmith could not count every table in its database';
  if (census.accountRows > 0) return `its database holds ${census.accountRows} account rows (teams, projects, keys, or members) that are not its own`;
  if (!allowData) {
    return census.dataRows > 0 ? `its database holds ${census.dataRows} rows` : null;
  }
  if (census.foreignRows > 0) return `its database holds ${census.foreignRows} rows of another project`;
  if (census.newestRowAt && census.newestRowAt > allowData.archivedAt) {
    return `its database has rows from ${census.newestRowAt}, after it was merged on ${allowData.archivedAt}; run the merge again to copy them`;
  }
  return null;
}

export async function planPrune(inv: ProjectInventory, census: Census): Promise<PrunePlan> {
  const candidates: PruneCandidate[] = [];
  const kept: PruneKept[] = [];
  const keep = (entry: ProjectEntry, reason: string) => kept.push({ entry, reason });
  const databaseOwners = new Map<string, Array<string | null>>();
  for (const p of inv.projects) {
    if (p.databaseName) databaseOwners.set(p.databaseName, [...(databaseOwners.get(p.databaseName) ?? []), p.projectId]);
  }
  const droppable = (entry: ProjectEntry): string | null => {
    const name = entry.databaseName;
    if (!name) return null;
    if (!DROPPABLE_DATABASE.test(name) || name === inv.accountDatabase) return `it keeps its records in the shared ${name} database`;
    if ((databaseOwners.get(name) ?? []).some((owner) => owner !== entry.projectId)) return `another project also uses ${name}`;
    return null;
  };

  for (const entry of inv.projects) {
    const flags = new Set(entry.flags);
    if (entry.projectId === null) {
      if (!knownEmpty(entry.counts)) {
        keep(entry, entry.counts === null ? 'MemSmith could not count its records' : `it holds ${recordTotal(entry.counts)} records, and no project names it`);
        continue;
      }
      const shared = droppable(entry);
      if (shared) { keep(entry, shared); continue; }
      const blocked = censusBlocks(await census(entry.databaseName!, 'from-name'), null);
      if (blocked) { keep(entry, blocked); continue; }
      candidates.push({ entry, reason: 'orphan-db', dropDatabase: entry.databaseName, deleteProject: false });
      continue;
    }

    const archived = flags.has('archived');
    const emptyish = flags.has('empty') || flags.has('missing-db');
    if (!archived && !emptyish && !flags.has('merging')) continue;
    if (flags.has('merging')) { keep(entry, `a merge into ${entry.mergingInto} did not finish; run it again`); continue; }
    if (entry.runtime === 'team' || entry.teamMarkerFolders.length > 0) { keep(entry, 'it is a team project'); continue; }
    if (entry.folders.length > 0) {
      keep(entry, `${entry.folders.join(', ')} still links to it`);
      continue;
    }
    if (inv.incompleteScans.length > 0) {
      keep(entry, `the marker scan of ${inv.incompleteScans.join(', ')} stopped early, so a folder there may still link to it`);
      continue;
    }

    if (archived) {
      if (!entry.databaseName) continue;
      const shared = droppable(entry);
      if (shared) { keep(entry, shared); continue; }
      const blocked = censusBlocks(
        await census(entry.databaseName, { projectId: entry.projectId, teamId: entry.teamId! }),
        { archivedAt: entry.archivedAt ?? '' },
      );
      if (blocked) { keep(entry, blocked); continue; }
      candidates.push({ entry, reason: 'archived', dropDatabase: entry.databaseName, deleteProject: false });
      continue;
    }

    if (!knownEmpty(entry.counts)) {
      keep(entry, entry.counts === null ? 'MemSmith could not count its records' : `it holds ${recordTotal(entry.counts)} records`);
      continue;
    }
    if (!entry.recordedPath) {
      keep(entry, 'no folder is recorded for it, so MemSmith cannot rule out a folder that still links to it');
      continue;
    }
    if (entry.databaseName) {
      const shared = droppable(entry);
      if (shared) { keep(entry, shared); continue; }
      const blocked = censusBlocks(await census(entry.databaseName, { projectId: entry.projectId, teamId: entry.teamId! }), null);
      if (blocked) { keep(entry, blocked); continue; }
    }
    candidates.push({ entry, reason: 'empty', dropDatabase: entry.databaseName, deleteProject: true });
  }
  return { candidates, kept, databaseOwners };
}

const DUMP_CONNECT_WAIT_MS = 5000;

// Resolves once pg_dump is connected or finished; rejects if it already failed.
async function waitForDumpConnection(db: ProjectsDb, name: string, dumping: Promise<unknown>): Promise<void> {
  const dump: { state: 'running' | 'done' | 'failed'; failure?: unknown } = { state: 'running' };
  void dumping.then(() => { dump.state = 'done'; }, (error) => { dump.state = 'failed'; dump.failure = error; });
  await Promise.resolve();
  const deadline = Date.now() + DUMP_CONNECT_WAIT_MS;
  while (dump.state === 'running' && Date.now() < deadline) {
    const r = await db.base.query(`SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = 'pg_dump'`, [name]);
    if (r.rows.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (dump.state === 'failed') throw dump.failure;
}

/**
 * Backs up, isolates, recounts, and drops one database. A connection held
 * from the start does the recount, because once connections are blocked no
 * new one can open. pg_dump is let in first; its snapshot predates the block,
 * and the recount on the live database catches anything written after it.
 * Returns true once the database is dropped.
 */
async function dumpBlockRecountDrop(deps: PruneDeps, candidate: PruneCandidate, name: string, file: string): Promise<boolean> {
  const { db } = deps;
  const { entry } = candidate;
  const holder = await db.pool(name).connect();
  let blocked = false;
  let released = false;
  try {
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? null;
    const dumping = deps.dump(db.urlFor(name), file);
    await waitForDumpConnection(db, name, dumping);
    await db.base.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
    blocked = true;
    await db.base.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND pid <> $2 AND application_name <> 'pg_dump'`,
      [name, pid],
    );
    await dumping;
    const recount = await db.census(name, entry.projectId ? { projectId: entry.projectId, teamId: entry.teamId! } : 'from-name', holder);
    const stop = censusBlocks(recount, candidate.reason === 'archived' ? { archivedAt: entry.archivedAt ?? '' } : null);
    if (stop) throw new Error(`${stop} (it changed after the preview)`);
    holder.release();
    released = true;
    await db.release(name);
    await db.base.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    return true;
  } catch (error) {
    if (blocked) await db.base.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`).catch(() => {});
    throw error;
  } finally {
    if (!released) holder.release();
  }
}

export interface PruneOutcome {
  candidate: PruneCandidate;
  backupFiles: string[];
  droppedDatabase: boolean;
  error: string | null;
}

export interface PruneDeps {
  db: ProjectsDb;
  dump: DumpDatabase;
  backupDir: string;
  now: () => Date;
  /** Called after a team row is deleted, so this machine forgets its key. */
  forgetTeamKey: (teamId: string) => void;
}

export async function executePrune(deps: PruneDeps, plan: PrunePlan): Promise<PruneOutcome[]> {
  const { db } = deps;
  if (!db.accountDatabaseKnown) throw new Error('MemSmith cannot tell which database holds your projects. Run `memsmith start` first.');
  return db.withMaintenanceLock(async () => {
    const outcomes: PruneOutcome[] = [];
    for (const candidate of plan.candidates) {
      const backupFiles: string[] = [];
      let droppedDatabase = false;
      const { entry } = candidate;
      try {
        const name = candidate.dropDatabase;
        if (name) {
          const owners = plan.databaseOwners.get(name) ?? [];
          if (!DROPPABLE_DATABASE.test(name) || name === db.accountDatabase || owners.some((o) => o !== entry.projectId)) {
            throw new Error(`refusing to drop ${name}`);
          }
        }
        if (candidate.deleteProject && entry.projectId) {
          const file = join(deps.backupDir, backupFileName('prune', `${entry.projectId}-account`, deps.now()));
          writeBackupFile(file, await db.accountRowsSql(entry.projectId, entry.teamId!, true));
          backupFiles.push(file);
        }
        if (name) {
          const file = join(deps.backupDir, backupFileName('prune', name, deps.now()));
          droppedDatabase = await dumpBlockRecountDrop(deps, candidate, name, file);
          backupFiles.push(file);
        }
        if (candidate.deleteProject && entry.projectId) {
          await db.base.query('DELETE FROM projects WHERE id = $1', [entry.projectId]);
          const team = await db.base.query(
            'DELETE FROM teams WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM projects WHERE team_id = $1)',
            [entry.teamId],
          );
          if ((team.rowCount ?? 0) > 0 && entry.teamId) deps.forgetTeamKey(entry.teamId);
        }
        outcomes.push({ candidate, backupFiles, droppedDatabase, error: null });
      } catch (error) {
        outcomes.push({ candidate, backupFiles, droppedDatabase, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcomes;
  });
}
