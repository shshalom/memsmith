// SPDX-License-Identifier: Apache-2.0
import { join } from 'path';
import { readMarkerAt } from '../identity/project-identity.js';
import { backupFileName, type DumpDatabase } from './backup.js';
import { recordTotal, type ProjectEntry, type ProjectInventory } from './inventory.js';
import type { ProjectsDb } from './projects-db.js';

export type PruneReason = 'orphan-db' | 'empty' | 'archived';

export interface PruneCandidate {
  entry: ProjectEntry;
  reason: PruneReason;
  /** Database to back up and drop; null when the project has none of its own. */
  dropDatabase: string | null;
  deleteProject: boolean;
}

export interface PruneKept {
  entry: ProjectEntry;
  reason: string;
}

export interface PrunePlan {
  candidates: PruneCandidate[];
  kept: PruneKept[];
}

const SHARED_DATABASES = new Set(['postgres', 'template0', 'template1']);

function liveFolders(entry: ProjectEntry): string[] {
  return entry.folders.filter((dir) => readMarkerAt(dir)?.projectId === entry.projectId);
}

export function planPrune(inv: ProjectInventory): PrunePlan {
  const candidates: PruneCandidate[] = [];
  const kept: PruneKept[] = [];
  const ownDatabase = (entry: ProjectEntry) =>
    entry.databaseName && entry.databaseName !== inv.accountDatabase && !SHARED_DATABASES.has(entry.databaseName)
      ? entry.databaseName
      : null;

  for (const entry of inv.projects) {
    const flags = new Set(entry.flags);
    if (entry.projectId === null) {
      if (recordTotal(entry.counts) === 0 && entry.counts !== null) {
        candidates.push({ entry, reason: 'orphan-db', dropDatabase: entry.databaseName, deleteProject: false });
      } else {
        kept.push({ entry, reason: entry.counts === null
          ? 'MemSmith could not read it'
          : `it holds ${recordTotal(entry.counts)} records, and no project names it` });
      }
      continue;
    }
    const archived = flags.has('archived');
    const empty = flags.has('empty') || (flags.has('missing-db') && recordTotal(entry.counts) === 0);
    if (!archived && !empty) continue;
    if (entry.runtime === 'team' || entry.teamMarkerFolders.length > 0) {
      kept.push({ entry, reason: 'it is a team project' });
      continue;
    }
    const live = liveFolders(entry);
    if (live.length > 0) {
      kept.push({ entry, reason: `${live.join(', ')} still links to it, and a session there would create it again` });
      continue;
    }
    if (entry.databaseName && !ownDatabase(entry)) {
      kept.push({ entry, reason: `its records live in the shared ${entry.databaseName} database` });
      continue;
    }
    candidates.push({ entry, reason: archived ? 'archived' : 'empty', dropDatabase: ownDatabase(entry), deleteProject: true });
  }
  return { candidates, kept };
}

export interface PruneOutcome {
  candidate: PruneCandidate;
  backupFile: string | null;
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
  const outcomes: PruneOutcome[] = [];
  for (const candidate of plan.candidates) {
    let backupFile: string | null = null;
    let droppedDatabase = false;
    try {
      const name = candidate.dropDatabase;
      if (name) {
        if (name === deps.db.accountDatabase || SHARED_DATABASES.has(name) || !/^[A-Za-z0-9_]+$/.test(name)) {
          throw new Error(`refusing to drop ${name}`);
        }
        backupFile = join(deps.backupDir, backupFileName('prune', name, deps.now()));
        await deps.dump(deps.db.urlFor(name), backupFile);
        await deps.db.release(name);
        await deps.db.base.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        droppedDatabase = true;
      }
      if (candidate.deleteProject && candidate.entry.projectId) {
        await deps.db.base.query('DELETE FROM projects WHERE id = $1', [candidate.entry.projectId]);
        const team = await deps.db.base.query(
          'DELETE FROM teams WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM projects WHERE team_id = $1)',
          [candidate.entry.teamId],
        );
        if ((team.rowCount ?? 0) > 0 && candidate.entry.teamId) deps.forgetTeamKey(candidate.entry.teamId);
      }
      outcomes.push({ candidate, backupFile, droppedDatabase, error: null });
    } catch (error) {
      outcomes.push({ candidate, backupFile, droppedDatabase, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
