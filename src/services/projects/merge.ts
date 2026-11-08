// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'path';
import { MARKER_NOTE, readMarkerAt, writeMarkerAt } from '../identity/project-identity.js';
import { canonicalPath, resolveProjectLocation, type ResolutionEnv } from '../identity/project-location.js';
import { backupFileName, type DumpDatabase } from './backup.js';
import { cancelActiveJobs, copyProject, type CopyReport, type CopyScope } from './copy-project.js';
import { ARCHIVED_AT_KEY, MERGED_INTO_KEY, type ProjectEntry, type ProjectInventory } from './inventory.js';
import type { ProjectsDb, Queryable } from './projects-db.js';

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
  /** Folders whose marker names the source project and will name the target. */
  repoint: string[];
}

export function decideMerge(from: ProjectEntry, into: ProjectEntry): MergeDecision {
  const refuse = (refusal: string): MergeDecision => ({ from, into, refusal, repoint: [] });
  if (from.projectId === into.projectId) return refuse(`${from.name} and ${into.name} are the same project.`);
  for (const p of [from, into]) {
    if (p.runtime === 'team' || p.teamMarkerFolders.length > 0) {
      return refuse(`${p.name} is a team project. memsmith merge combines local projects only.`);
    }
  }
  if (into.mergedInto) return refuse(`${into.name} was merged into ${into.mergedInto}. Merge into that project instead.`);
  if (from.mergedInto && from.mergedInto !== into.projectId) {
    return refuse(`${from.name} was already merged into ${from.mergedInto}.`);
  }
  if (!from.databaseName) return refuse(`${from.name} has no database, so it has no records to merge.`);
  if (!into.databaseName) {
    return refuse(`${into.name} has no database yet. Start a session in its folder first, or merge it the other way.`);
  }
  return { from, into, refusal: null, repoint: [...from.folders] };
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

async function inTransactions<T>(
  db: ProjectsDb,
  d: MergeDecision,
  fn: (source: Queryable, target: Queryable) => Promise<T>,
): Promise<T> {
  const source = await db.pool(d.from.databaseName!).connect();
  const target = await db.pool(d.into.databaseName!).connect();
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await target.query('BEGIN');
    const result = await fn(source, target);
    await target.query('COMMIT');
    await source.query('COMMIT');
    return result;
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {});
    await source.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    target.release();
    source.release();
  }
}

export interface MergeDeps {
  db: ProjectsDb;
  dump: DumpDatabase;
  backupDir: string;
  now: () => Date;
}

export interface MergeResult {
  backupFile: string;
  cancelledJobs: number;
  report: CopyReport;
  /** Rows written to the source while the copy ran, copied by a second pass. */
  lateRows: number;
  repointed: string[];
  /** Folders left alone because their marker changed since the preview. */
  skippedMarkers: Array<{ dir: string; reason: string }>;
}

export async function executeMerge(deps: MergeDeps, d: MergeDecision): Promise<MergeResult> {
  if (d.refusal) throw new Error(d.refusal);
  const { db } = deps;
  const scope = scopeOf(d);

  const backupFile = join(deps.backupDir, backupFileName('merge', scope.fromProjectId, deps.now()));
  try {
    await deps.dump(db.urlFor(d.from.databaseName!), backupFile);
  } catch (error) {
    throw new Error(`the backup of ${d.from.databaseName} failed, so nothing changed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const source = db.pool(d.from.databaseName!);
  let cancelledJobs = await cancelActiveJobs(source, scope.fromProjectId, scope.intoProjectId);
  const report = await inTransactions(db, d, (s, t) => copyProject(s, t, scope, true));

  await db.base.query(
    `UPDATE projects SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object($2::text, $3::text, $4::text, $5::text)
      WHERE id = $1`,
    [scope.fromProjectId, MERGED_INTO_KEY, scope.intoProjectId, ARCHIVED_AT_KEY, deps.now().toISOString()],
  );

  const repointed: string[] = [];
  const skippedMarkers: MergeResult['skippedMarkers'] = [];
  for (const dir of d.repoint) {
    const current = readMarkerAt(dir);
    if (!current || current.projectId !== scope.fromProjectId) {
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

  cancelledJobs += await cancelActiveJobs(source, scope.fromProjectId, scope.intoProjectId);
  const late = await inTransactions(db, d, (s, t) => copyProject(s, t, scope, true));
  const lateRows = Object.values(late.tables).reduce((sum, t) => sum + t.copy, 0);

  return { backupFile, cancelledJobs, report, lateRows, repointed, skippedMarkers };
}
