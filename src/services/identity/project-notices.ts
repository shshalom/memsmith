// SPDX-License-Identifier: Apache-2.0
//
// One-line notices a session shows when MemSmith picks a project the user did
// not choose: a project it just created, or one found above the folder.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';
import { readMarkerAt } from './project-identity.js';
import { resolveProjectLocation, type ResolutionEnv } from './project-location.js';

export const NOTICE_RECORD_FILE = 'project-notices.json';

interface NoticeRecord { folders: Record<string, string> }

export function createdProjectNotice(created: { root: string; name: string }): string {
  return `MemSmith created project ${created.name} for ${created.root}. `
    + 'Run `memsmith project` to check it, or `memsmith link` to use a different project.';
}

export function borrowedProjectNotice(name: string, root: string): string {
  return `MemSmith is using project ${name} from ${root} for this folder. `
    + 'Run `memsmith project` to check it, or `memsmith link --new` to give this folder its own project.';
}

function readRecord(path: string): NoticeRecord {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<NoticeRecord>;
    return { folders: parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {} };
  } catch {
    return { folders: {} };
  }
}

/** True the first time `folder` is noted for `projectId`; false after that. */
export function claimFolderNotice(folder: string, projectId: string, dataDir: string = resolveDataDir()): boolean {
  const path = join(dataDir, NOTICE_RECORD_FILE);
  const record = readRecord(path);
  if (record.folders[folder] === projectId) return false;
  record.folders[folder] = projectId;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), 'utf-8');
    renameSync(temp, path);
  } catch {
    // Without a record every later prompt would repeat it, so stay quiet.
    return false;
  }
  return true;
}

export function projectNoticeFor(
  cwd: string,
  minted: { projectId?: string; created?: { root: string; name: string } } | null | undefined,
  options: { env?: ResolutionEnv; dataDir?: string } = {},
): string | null {
  const location = resolveProjectLocation(cwd, options.env);
  const folderKey = location.gitRoot ?? location.folder;
  if (minted?.created && minted.projectId) {
    claimFolderNotice(folderKey, minted.projectId, options.dataDir);
    return createdProjectNotice(minted.created);
  }
  if (!location.borrowed || !location.markerFound) return null;
  const marker = readMarkerAt(location.root);
  if (!marker || !claimFolderNotice(folderKey, marker.projectId, options.dataDir)) return null;
  return borrowedProjectNotice(basename(location.root) || marker.projectId, location.root);
}
