// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'path';
import { MARKER_NOTE, readMarkerAt, writeMarkerAt } from '../identity/project-identity.js';
import { canonicalPath, resolveProjectLocation, type ResolutionEnv } from '../identity/project-location.js';
import { backupFileName, type DumpDatabase } from './backup.js';
import { cancelSourceJobs, copyProject, type CopyReport, type CopyScope } from './copy-project.js';
import {
  ARCHIVED_AT_KEY,
  MERGED_INTO_KEY,
  MERGING_INTO_KEY,
  mergedIntoChain,
  type ProjectEntry,
  type ProjectInventory,
} from './inventory.js';
import type { ProjectsDb, Queryable } from './projects-db.js';
import { projectDatabaseName } from '../../server/runtime/resolve-project-database.js';

export interface RefContext {
  cwd: string;
  env: ResolutionEnv;
}

function looksLikePath(ref: string): boolean {
  return ref.startsWith('.') || ref.startsWith('~') || ref.includes('/') || ref.includes('\\');
}

/** Finds a project by id, by name, or by a folder path (which must contain `/` or start with `.` or `~`). */
export function resolveProjectRef(inv: ProjectInventory, ref: string, ctx: RefContext): ProjectEntry | string {
  const projects = inv.projects.filter((p) => p.projectId !== null);
  if (looksLikePath(ref)) {
    const home = canonicalPath(ctx.env.home);
    const path = ref === '~' ? home : ref.startsWith('~/') ? join(home, ref.slice(2)) : resolve(ctx.cwd, ref);
    const loc = resolveProjectLocation(path, ctx.env);
    const marker = loc.markerFound ? readMarkerAt(loc.root) : null;
    if (!marker) return `The folder ${ref} has no MemSmith project.`;
    return projects.find((p) => p.projectId === marker.projectId)
      ?? `The folder ${ref} links to project ${marker.projectId}, which this machine's MemSmith server does not know.`;
  }
  const byId = projects.filter((p) => p.projectId === ref);
  if (byId.length === 1) return byId[0];
  const byName = projects.filter((p) => p.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    return [`More than one project is named ${ref}. Use one of these ids:`, ...byName.map((p) => `  ${p.projectId}`)].join('\n');
  }
  return `No project has the id or name ${ref}. To list your projects, run: memsmith projects`;
}

export interface MergeDecision {
  from: ProjectEntry;
  into: ProjectEntry;
  refusal: string | null;
  /** Folders whose marker names the source, or a project merged into it earlier, and will name the target. */
  repoint: string[];
  /** Projects whose markers the merge rewrites: the source and any project merged into it earlier. */
  repointProjectIds: string[];
}

export function decideMerge(inv: ProjectInventory, from: ProjectEntry, into: ProjectEntry): MergeDecision {
  const refuse = (refusal: string): MergeDecision => ({ from, into, refusal, repoint: [], repointProjectIds: [] });
  if (from.projectId === into.projectId) return refuse(`${from.name} and ${into.name} are the same project.`);
  for (const p of [from, into]) {
    if (p.runtime === 'team' || p.teamMarkerFolders.length > 0) {
      return refuse(`${p.name} is a team project. memsmith merge combines local projects only.`);
    }
  }
  if (into.mergedInto || into.mergingInto) {
    return refuse(`${into.name} was merged into ${into.mergedInto ?? into.mergingInto}. Merge into that project instead.`);
  }
  const previous = from.mergedInto ?? from.mergingInto;
  if (previous && previous !== into.projectId) return refuse(`${from.name} was already merged into ${previous}.`);
  if (!from.databaseName) return refuse(`${from.name} has no database, so it has no records to merge.`);
  if (!into.databaseName) {
    return refuse(`${into.name} has no database yet. Start a session in its folder first, or merge it the other way.`);
  }
  if (from.databaseName === into.databaseName) {
    return refuse(`${from.name} and ${into.name} keep their records in the same database (${from.databaseName}), which memsmith merge does not support.`);
  }
  // The server reads a project from msp_<id>, except the project it starts
  // in, which it reads from the account database. Records merged anywhere
  // else, and the jobs moved with them, would never be found.
  const servedFrom = projectDatabaseName(into.projectId!);
  if (into.databaseName !== servedFrom) {
    const startProject = into.databaseName === inv.accountDatabase ? inv.baseProjectId : undefined;
    if (startProject === null) {
      return refuse(`${into.name} keeps its records in ${into.databaseName}, and MemSmith can't tell whether the server reads ${into.name} from there. Run \`memsmith restart\`, then merge again.`);
    }
    if (startProject !== into.projectId) {
      return refuse(`${into.name} keeps its records in ${into.databaseName}, but the server reads ${into.name} from ${servedFrom}, so merged records would not be found. Merge ${into.name} into another project instead.`);
    }
  }
  const earlier = mergedIntoChain(inv, from.projectId!);
  const chainTeam = earlier.find((p) => p.teamMarkerFolders.length > 0);
  if (chainTeam) return refuse(`${chainTeam.name}, which was merged into ${from.name}, has a team marker.`);
  const repoint = [...new Set([...from.folders, ...earlier.flatMap((p) => p.folders)])];
  return { from, into, refusal: null, repoint, repointProjectIds: [from.projectId!, ...earlier.map((p) => p.projectId!)] };
}

function scopeOf(d: MergeDecision): CopyScope {
  return {
    fromProjectId: d.from.projectId!,
    intoProjectId: d.into.projectId!,
    intoTeamId: d.into.teamId!,
    intoName: d.into.name,
  };
}

export async function previewMerge(db: ProjectsDb, d: MergeDecision): Promise<CopyReport> {
  return copyProject(db.pool(d.from.databaseName!), db.pool(d.into.databaseName!), scopeOf(d), false);
}

async function copyInTransactions(db: ProjectsDb, d: MergeDecision): Promise<CopyReport> {
  const source = await db.pool(d.from.databaseName!).connect();
  const target = await db.pool(d.into.databaseName!).connect();
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await target.query('BEGIN');
    const report = await copyProject(source, target, scopeOf(d), true);
    await target.query('COMMIT');
    await source.query('COMMIT');
    return report;
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {});
    await source.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    target.release();
    source.release();
  }
}

export type MergeStage = 'backup' | 'mark' | 'copy' | 'cancel-jobs' | 'archive' | 'markers' | 'catch-up';

/** A merge that stopped. `completed` lists the stages that finished before `stage` failed. */
export class MergeStageError extends Error {
  constructor(readonly stage: MergeStage, readonly completed: MergeStage[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export interface MergeDeps {
  db: ProjectsDb;
  dump: DumpDatabase;
  backupDir: string;
  now: () => Date;
  /** Test seams for the copy and the source-job cancel. */
  ops?: {
    copy?: (db: ProjectsDb, d: MergeDecision) => Promise<CopyReport>;
    cancel?: (source: Queryable, ids: string[], intoProjectId: string) => Promise<number>;
  };
}

export interface MergeResult {
  backupFile: string;
  /** Source jobs that were queued or processing, now queued in the target and cancelled in the source. */
  movedJobs: number;
  report: CopyReport;
  /** Rows written or changed in the source while the copy ran, copied by a second pass. */
  lateRows: number;
  repointed: string[];
  skippedMarkers: Array<{ dir: string; reason: string }>;
}

async function setMergeState(base: Queryable, projectId: string, patch: Record<string, string>, remove: string[]): Promise<void> {
  await base.query(
    `UPDATE projects SET metadata = (COALESCE(metadata, '{}'::jsonb) - $3::text[]) || $2::jsonb WHERE id = $1`,
    [projectId, JSON.stringify(patch), remove],
  );
}

export async function executeMerge(deps: MergeDeps, d: MergeDecision): Promise<MergeResult> {
  if (d.refusal) throw new Error(d.refusal);
  const { db } = deps;
  if (!db.accountDatabaseKnown) {
    throw new MergeStageError('backup', [], new Error('MemSmith cannot tell which database holds your projects. Run `memsmith start` first.'));
  }
  return db.withMaintenanceLock(async () => {
    const scope = scopeOf(d);
    const copy = deps.ops?.copy ?? copyInTransactions;
    const cancel = deps.ops?.cancel ?? cancelSourceJobs;
    const completed: MergeStage[] = [];
    const stage = async <T>(name: MergeStage, fn: () => Promise<T>): Promise<T> => {
      try {
        const result = await fn();
        completed.push(name);
        return result;
      } catch (error) {
        throw new MergeStageError(name, [...completed], error);
      }
    };

    const backupFile = join(deps.backupDir, backupFileName('merge', scope.fromProjectId, deps.now()));
    await stage('backup', () => deps.dump(db.urlFor(d.from.databaseName!), backupFile));

    // Team-wide reads skip a project marked merging, so the source's rows are
    // never read twice once the copy commits.
    await stage('mark', () => setMergeState(db.base, scope.fromProjectId, { [MERGING_INTO_KEY]: scope.intoProjectId }, []));

    const source = db.pool(d.from.databaseName!);
    let report: CopyReport;
    try {
      report = await stage('copy', () => copy(db, d));
    } catch (error) {
      if (!d.from.mergingInto) await setMergeState(db.base, scope.fromProjectId, {}, [MERGING_INTO_KEY]).catch(() => {});
      throw error;
    }
    let movedJobs = await stage('cancel-jobs', () => cancel(source, report.activeJobIds, scope.intoProjectId));

    await stage('archive', () => setMergeState(
      db.base, scope.fromProjectId,
      { [MERGED_INTO_KEY]: scope.intoProjectId, [ARCHIVED_AT_KEY]: deps.now().toISOString() },
      [MERGING_INTO_KEY],
    ));

    const repointed: string[] = [];
    const skippedMarkers: MergeResult['skippedMarkers'] = [];
    await stage('markers', async () => {
      for (const dir of d.repoint) {
        const current = readMarkerAt(dir);
        if (!current || !d.repointProjectIds.includes(current.projectId)) {
          skippedMarkers.push({ dir, reason: 'its marker no longer names the merged project' });
          continue;
        }
        if (current.runtime === 'server') {
          skippedMarkers.push({ dir, reason: 'its marker names a team project' });
          continue;
        }
        writeMarkerAt(dir, {
          teamId: scope.intoTeamId,
          projectId: scope.intoProjectId,
          note: MARKER_NOTE,
          ...(current.runtime ? { runtime: current.runtime } : {}),
          databaseName: d.into.databaseName!,
        });
        repointed.push(dir);
      }
    });

    // One stage, so a failure anywhere in it is reported as the catch-up.
    const { lateRows, lateJobs } = await stage('catch-up', async () => {
      const late = await copy(db, d);
      const jobs = await cancel(source, late.activeJobIds, scope.intoProjectId);
      // Prune compares the source's newest row with archivedAt; the merge's
      // own writes to the source (cancelled jobs) must not count as new rows.
      await setMergeState(db.base, scope.fromProjectId, { [ARCHIVED_AT_KEY]: deps.now().toISOString() }, []);
      return { lateRows: Object.values(late.tables).reduce((sum, t) => sum + t.copy + t.updated, 0), lateJobs: jobs };
    });
    movedJobs += lateJobs;

    return { backupFile, movedJobs, report, lateRows, repointed, skippedMarkers };
  });
}
