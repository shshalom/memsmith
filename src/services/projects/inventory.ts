// SPDX-License-Identifier: Apache-2.0
import { basename } from 'path';
import { PROJECT_PATH_KEY, readMarkerAt, type ProjectMarker } from '../identity/project-identity.js';
import { projectDatabaseName } from '../../server/runtime/resolve-project-database.js';
import { findStrayMarkers, type StrayMarker } from './stray-markers.js';

export const MERGED_INTO_KEY = 'mergedInto';
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
  lastActivity: string | null;
}

export interface InventorySource {
  accountDatabase: string;
  listProjects(): Promise<ProjectRow[]>;
  listDatabases(): Promise<string[]>;
  /** Rows for `projectId` in `databaseName`, or every row when `projectId` is null. Null when unreadable. */
  recordStats(databaseName: string, projectId: string | null): Promise<RecordStats | null>;
}

export interface InventoryOptions {
  /** Project roots known outside the database, such as the current folder's. */
  extraRoots?: string[];
  hasKeyForTeam?: (teamId: string) => boolean;
}

export type ProjectFlag = 'empty' | 'orphan-db' | 'missing-db' | 'stray' | 'archived';

export interface ProjectEntry {
  /** Null for an orphan database, which has no projects row. */
  projectId: string | null;
  teamId: string | null;
  name: string;
  team: string;
  runtime: 'local' | 'team';
  folders: string[];
  databaseName: string | null;
  counts: RecordStats | null;
  lastActivity: string | null;
  flags: ProjectFlag[];
  mergedInto?: string;
  archivedAt?: string;
  strayUnder?: Array<{ root: string; projectId: string }>;
  /** Folders whose marker names this project as a team project; merge never rewrites them. */
  teamMarkerFolders: string[];
}

export interface ProjectInventory {
  accountDatabase: string;
  projects: ProjectEntry[];
  strays: StrayMarker[];
}

const PROJECT_DATABASE = /^msp_[0-9a-f]{32}$/;

export function recordTotal(stats: RecordStats | null): number {
  return stats ? stats.observations + stats.notes + stats.events : 0;
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

export async function loadInventory(src: InventorySource, opts: InventoryOptions): Promise<ProjectInventory> {
  const hasKeyForTeam = opts.hasKeyForTeam ?? (() => false);
  const rows = await src.listProjects();
  const databases = new Set(await src.listDatabases());
  const known = new Set(rows.map((r) => r.id));

  const folders = new Map<string, string[]>(rows.map((r) => [r.id, []]));
  const markers = new Map<string, ProjectMarker[]>(rows.map((r) => [r.id, []]));
  const noteMarker = (dir: string, marker: ProjectMarker) => {
    if (!known.has(marker.projectId)) return;
    pushUnique(folders.get(marker.projectId)!, dir);
    markers.get(marker.projectId)!.push(marker);
  };

  const roots: Array<{ dir: string; projectId: string }> = [];
  for (const row of rows) {
    const path = recordedPath(row);
    const marker = path ? readMarkerAt(path) : null;
    if (path && marker?.projectId === row.id) {
      noteMarker(path, marker);
      roots.push({ dir: path, projectId: row.id });
    }
  }
  for (const dir of opts.extraRoots ?? []) {
    const marker = readMarkerAt(dir);
    if (!marker) continue;
    noteMarker(dir, marker);
    if (!roots.some((r) => r.dir === dir)) roots.push({ dir, projectId: marker.projectId });
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
    let counts: RecordStats | null = null;
    if (databaseName) {
      counts = await src.recordStats(databaseName, row.id);
    } else {
      const legacy = await src.recordStats(src.accountDatabase, row.id);
      if (recordTotal(legacy) > 0) {
        databaseName = src.accountDatabase;
        counts = legacy;
      }
    }

    const mergedInto = row.metadata?.[MERGED_INTO_KEY];
    const archivedAt = row.metadata?.[ARCHIVED_AT_KEY];
    const flags: ProjectFlag[] = [];
    if (typeof mergedInto === 'string') flags.push('archived');
    if (!databaseName) flags.push('missing-db');
    else if (counts && recordTotal(counts) === 0 && typeof mergedInto !== 'string') flags.push('empty');
    if (strayUnder.has(row.id)) flags.push('stray');

    projects.push({
      projectId: row.id,
      teamId: row.teamId,
      name: row.name && row.name !== row.id ? row.name : basename(folders.get(row.id)![0] ?? '') || row.id.slice(0, 8),
      team: teamLabel(teamMarker, hasKeyForTeam),
      runtime: teamMarker ? 'team' : 'local',
      folders: folders.get(row.id)!,
      databaseName,
      counts,
      lastActivity: counts?.lastActivity ?? null,
      flags,
      ...(typeof mergedInto === 'string' ? { mergedInto } : {}),
      ...(typeof archivedAt === 'string' ? { archivedAt } : {}),
      ...(strayUnder.has(row.id) ? { strayUnder: strayUnder.get(row.id) } : {}),
      teamMarkerFolders: folders.get(row.id)!.filter((dir) => readMarkerAt(dir)?.runtime === 'server'),
    });
  }

  const owned = new Set(rows.map((r) => projectDatabaseName(r.id)));
  for (const name of [...databases].sort()) {
    if (!PROJECT_DATABASE.test(name) || owned.has(name) || name === src.accountDatabase) continue;
    const counts = await src.recordStats(name, null);
    projects.push({
      projectId: null,
      teamId: null,
      name,
      team: 'none',
      runtime: 'local',
      folders: [],
      databaseName: name,
      counts,
      lastActivity: counts?.lastActivity ?? null,
      flags: counts && recordTotal(counts) === 0 ? ['orphan-db', 'empty'] : ['orphan-db'],
      teamMarkerFolders: [],
    });
  }

  return { accountDatabase: src.accountDatabase, projects, strays };
}
