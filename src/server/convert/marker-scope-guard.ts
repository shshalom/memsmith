// SPDX-License-Identifier: Apache-2.0
//
// A marker above the git repositories that use it (reachable only through a
// search root) belongs to every one of them. Converting that project would
// flip all of them to the team at once and share a marker that no repository
// contains, so convert refuses until one repository is linked on its own.

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  canonicalPath,
  findGitRoot,
  MARKER_RELATIVE_PATH,
  resolveProjectLocation,
  samePath,
  type ResolutionEnv,
} from '../../services/identity/project-location.js';

const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_DIRS = 2000;
const SCAN_SKIP = new Set(['node_modules', 'Pods', 'DerivedData', 'build', 'dist', 'vendor', 'target']);

/** Git repositories below `markerDir` that resolve to its marker. */
export function reposUsingAncestorMarker(markerPath: string, env?: ResolutionEnv): string[] {
  const markerDir = canonicalPath(markerPath);
  if (findGitRoot(markerDir) !== null) return [];
  const repos: string[] = [];
  let visited = 0;
  const scan = (dir: string, depth: number) => {
    if (depth > SCAN_MAX_DEPTH || visited >= SCAN_MAX_DIRS) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SCAN_SKIP.has(entry.name)) continue;
      visited++;
      const child = join(dir, entry.name);
      if (existsSync(join(child, MARKER_RELATIVE_PATH))) continue;
      if (existsSync(join(child, '.git'))) {
        if (samePath(resolveProjectLocation(child, env).root, markerDir)) repos.push(child);
        continue;
      }
      scan(child, depth + 1);
    }
  };
  scan(markerDir, 1);
  return repos;
}

export function convertRefusalForMarkerDir(markerDir: string, env?: ResolutionEnv): string | null {
  const repos = reposUsingAncestorMarker(markerDir, env);
  if (repos.length === 0) return null;
  return `This project's marker is in ${markerDir}, above the git repositories that use it `
    + `(${repos.slice(0, 3).join(', ')}${repos.length > 3 ? ', and more' : ''}). Converting it would move all of them `
    + 'to the team. To convert one repository, run `memsmith link --new` in it first, then convert that project.';
}
