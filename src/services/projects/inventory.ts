// SPDX-License-Identifier: Apache-2.0
import { basename } from 'path';
import { PROJECT_PATH_KEY, readMarkerAt, scanMarkerDirs, type ProjectMarker } from '../identity/project-identity.js';
import { projectDatabaseName } from '../../server/runtime/resolve-project-database.js';
import { findStrayMarkers, type StrayMarker } from './stray-markers.js';

export const MERGED_INTO_KEY = 'mergedInto';
export const MERGING_INTO_KEY = 'mergingInto';
export const ARCHIVED_AT_KEY = 'archivedAt';

export interface ProjectRow {
  id: string;
  teamId: string;
  name: string;
  metadata: Record<string, unknown> | null;
}

export interface RecordStats {
  observations: number;
  notes: number;
  events: number;
  sessions: number;
  /** Generation jobs waiting to run. */
  queuedJobs: number;
  lastActivity: string | null;
}

export interface InventorySource {
  accountDatabase: string;
  /** The project the running server reads from the account database, when the server recorded it. */
  baseProjectId?: string | null;
  listProjects(): Promise<ProjectRow[]>;
  listDatabases(): Promise<string[]>;
  /** Rows for `projectId` in `databaseName`, or every row when `projectId` is null. Null when unreadable. */
  recordStats(databaseName: string, projectId: string | null): Promise<RecordStats | null>;
  /** Why the last recordStats for `databaseName` returned null. */
  countError?(databaseName: string): string | undefined;
  /** Closes `databaseName`'s connections once its counts are read. */
  release?(databaseName: string): Promise<void>;
}

export interface InventoryOptions {
  /** Project roots known outside the database, such as the current folder's. */
  extraRoots?: string[];
  /** Folders to scan for markers that name a project, such as the configured search roots. */
  scanRoots?: string[];
  hasKeyForTeam?: (teamId: string) => boolean;
}

export type ProjectFlag = 'empty' | 'orphan-db' | 'missing-db' | 'stray' | 'archived' | 'merging';

export interface ProjectEntry {
  /** Null for an orphan database, which has no projects row. */
  projectId: string | null;
  teamId: string | null;
  name: string;
  team: string;
  runtime: 'local' | 'team';
  folders: string[];
  /** The folder recorded the last time a session registered the project, whether or not its marker still names it. */
  recordedPath: string | null;
  databaseName: string | null;
  /** Null when MemSmith could not count the records; never read that as empty. */
  counts: RecordStats | null;
  countError?: string;
  lastActivity: string | null;
  flags: ProjectFlag[];
  mergedInto?: string;
  mergingInto?: string;
  archivedAt?: string;
  strayUnder?: Array<{ root: string; projectId: string }>;
  /** Folders whose marker names this project as a team project; merge never rewrites them. */
  teamMarkerFolders: string[];
}

export interface ProjectInventory {
  accountDatabase: string;
  baseProjectId?: string | null;
  projects: ProjectEntry[];
  strays: StrayMarker[];
  /** Scanned folders where a bound cut the marker scan short. */
  incompleteScans: string[];
}

const PROJECT_DATABASE = /^msp_[0-9a-f]{32}$/;

export function recordTotal(stats: RecordStats): number {
  return stats.observations + stats.notes + stats.events;
}

/** True only for a successful count of zero. */
export function knownEmpty(stats: RecordStats | null): boolean {
  return stats !== null && recordTotal(stats) === 0;
}

function recordedPath(row: ProjectRow): string | null {
  const path = row.metadata?.[PROJECT_PATH_KEY];
  return typeof path === 'string' && path.trim() ? path : null;
}

function teamLabel(marker: ProjectMarker | undefined, hasKeyForTeam: (teamId: string) => boolean): string {
  if (!marker || marker.runtime !== 'server') return 'local';
  const server = marker.serverUrl ?? 'an unknown server';
  return hasKeyForTeam(marker.teamId) ? `joined team at ${server}` : `team at ${server}, not joined on this machine`;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function metaString(row: ProjectRow, key: string): string | undefined {
  const v = row.metadata?.[key];
  return typeof v === 'string' && v ? v : undefined;
}

export async function loadInventory(src: InventorySource, opts: InventoryOptions): Promise<ProjectInventory> {
  const hasKeyForTeam = opts.hasKeyForTeam ?? (() => false);
  const rows = await src.listProjects();
  const databases = new Set(await src.listDatabases());
  const known = new Set(rows.map((r) => r.id));

  const folders = new Map<string, string[]>(rows.map((r) => [r.id, []]));
  const markers = new Map<string, ProjectMarker[]>(rows.map((r) => [r.id, []]));
  const noteMarker = (dir: string, marker: ProjectMarker) => {
    if (!known.has(marker.projectId)) return;
    if (folders.get(marker.projectId)!.includes(dir)) return;
    folders.get(marker.projectId)!.push(dir);
    markers.get(marker.projectId)!.push(marker);
  };

  const roots: Array<{ dir: string; projectId: string }> = [];
  const addRoot = (dir: string, marker: ProjectMarker) => {
    noteMarker(dir, marker);
    if (!roots.some((r) => r.dir === dir)) roots.push({ dir, projectId: marker.projectId });
  };
  for (const row of rows) {
    const path = recordedPath(row);
    const marker = path ? readMarkerAt(path) : null;
    if (path && marker) addRoot(path, marker);
  }
  for (const dir of opts.extraRoots ?? []) {
    const marker = readMarkerAt(dir);
    if (marker) addRoot(dir, marker);
  }
  const incompleteScans: string[] = [];
  for (const scanRoot of opts.scanRoots ?? []) {
    const scan = scanMarkerDirs(scanRoot);
    if (!scan.complete) incompleteScans.push(scanRoot);
    for (const dir of scan.dirs) {
      const marker = readMarkerAt(dir);
      if (marker) noteMarker(dir, marker);
    }
  }

  const strays: StrayMarker[] = [];
  const strayUnder = new Map<string, Array<{ root: string; projectId: string }>>();
  for (const root of roots) {
    for (const stray of findStrayMarkers(root.dir, root.projectId)) {
      if (strays.some((s) => s.dir === stray.dir)) continue;
      strays.push(stray);
      noteMarker(stray.dir, stray.marker);
      const under = strayUnder.get(stray.marker.projectId) ?? [];
      under.push({ root: root.dir, projectId: root.projectId });
      strayUnder.set(stray.marker.projectId, under);
    }
  }

  const projects: ProjectEntry[] = [];
  for (const row of rows) {
    const projectMarkers = markers.get(row.id)!;
    const teamMarker = projectMarkers.find((m) => m.runtime === 'server');
    const stamped = projectMarkers.map((m) => m.databaseName).find((n) => n && databases.has(n));
    let databaseName: string | null = stamped
      ?? (databases.has(projectDatabaseName(row.id)) ? projectDatabaseName(row.id) : null);
    let counts: RecordStats | null;
    let countedIn: string;
    if (databaseName) {
      countedIn = databaseName;
      counts = await src.recordStats(databaseName, row.id);
    } else {
      countedIn = src.accountDatabase;
      counts = await src.recordStats(src.accountDatabase, row.id);
      if (counts && recordTotal(counts) > 0) databaseName = src.accountDatabase;
    }
    const countError = counts ? undefined : src.countError?.(countedIn);
    if (countedIn !== src.accountDatabase) await src.release?.(countedIn);

    const mergedInto = metaString(row, MERGED_INTO_KEY);
    const mergingInto = metaString(row, MERGING_INTO_KEY);
    const archivedAt = metaString(row, ARCHIVED_AT_KEY);
    const flags: ProjectFlag[] = [];
    if (mergedInto) flags.push('archived');
    else if (mergingInto) flags.push('merging');
    if (!databaseName) flags.push('missing-db');
    else if (knownEmpty(counts) && !mergedInto && !mergingInto) flags.push('empty');
    if (strayUnder.has(row.id)) flags.push('stray');

    const projectFolders = folders.get(row.id)!;
    projects.push({
      projectId: row.id,
      teamId: row.teamId,
      name: row.name && row.name !== row.id ? row.name : basename(projectFolders[0] ?? '') || row.id.slice(0, 8),
      team: teamLabel(teamMarker, hasKeyForTeam),
      runtime: teamMarker ? 'team' : 'local',
      folders: projectFolders,
      recordedPath: recordedPath(row),
      databaseName,
      counts,
      ...(countError ? { countError } : {}),
      lastActivity: counts?.lastActivity ?? null,
      flags,
      ...(mergedInto ? { mergedInto } : {}),
      ...(mergingInto ? { mergingInto } : {}),
      ...(archivedAt ? { archivedAt } : {}),
      ...(strayUnder.has(row.id) ? { strayUnder: strayUnder.get(row.id) } : {}),
      teamMarkerFolders: projectFolders.filter((dir) => readMarkerAt(dir)?.runtime === 'server'),
    });
  }

  const owned = new Set<string>(rows.map((r) => projectDatabaseName(r.id)));
  for (const p of projects) if (p.databaseName) owned.add(p.databaseName);
  for (const name of [...databases].sort()) {
    if (!PROJECT_DATABASE.test(name) || owned.has(name) || name === src.accountDatabase) continue;
    const counts = await src.recordStats(name, null);
    const countError = counts ? undefined : src.countError?.(name);
    await src.release?.(name);
    projects.push({
      projectId: null,
      teamId: null,
      name,
      team: 'none',
      runtime: 'local',
      folders: [],
      recordedPath: null,
      databaseName: name,
      counts,
      ...(countError ? { countError } : {}),
      lastActivity: counts?.lastActivity ?? null,
      flags: knownEmpty(counts) ? ['orphan-db', 'empty'] : ['orphan-db'],
      teamMarkerFolders: [],
    });
  }

  return { accountDatabase: src.accountDatabase, baseProjectId: src.baseProjectId ?? null, projects, strays, incompleteScans };
}

/** Projects whose merges lead, possibly through other merges, into `projectId`. */
export function mergedIntoChain(inv: ProjectInventory, projectId: string, maxHops = 8): ProjectEntry[] {
  const out: ProjectEntry[] = [];
  const byId = new Map(inv.projects.filter((p) => p.projectId).map((p) => [p.projectId!, p]));
  for (const p of byId.values()) {
    let current = p.mergedInto;
    const seen = new Set<string>([p.projectId!]);
    for (let hop = 0; current && hop < maxHops && !seen.has(current); hop++) {
      if (current === projectId) { out.push(p); break; }
      seen.add(current);
      current = byId.get(current)?.mergedInto;
    }
  }
  return out;
}
