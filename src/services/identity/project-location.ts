// SPDX-License-Identifier: Apache-2.0
//
// Hooks run this on every session start and tool call, so it reads files only
// and never spawns git (tests/services/identity/project-worktree.test.ts).

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';
import { loadFromFileOnce } from '../../shared/hook-settings.js';

export const MARKER_RELATIVE_PATH = '.memsmith/project.json';
export const SEARCH_ROOTS_SETTING = 'MEMSMITH_PROJECT_SEARCH_ROOTS' as const;

export interface ResolutionEnv {
  home: string;
  searchRoots: string[];
}

export type WalkBoundary =
  | { kind: 'search-root'; dir: string }
  | { kind: 'home'; dir: string }
  | { kind: 'repo'; dir: string };

export interface ProjectLocation {
  folder: string;
  root: string;
  markerFound: boolean;
  reason: 'marker' | 'main-worktree' | 'git-root' | 'folder';
  boundary: WalkBoundary;
  gitRoot: string | null;
  mainWorktree?: string;
  main?: ProjectLocation;
}

export function parseSearchRoots(raw: string, home: string): string[] {
  const roots: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed;
    if (!isAbsolute(expanded)) continue;
    roots.push(resolve(expanded));
  }
  return roots;
}

export function defaultResolutionEnv(): ResolutionEnv {
  const home = resolve(homedir());
  const raw = process.env[SEARCH_ROOTS_SETTING] ?? loadFromFileOnce().MEMSMITH_PROJECT_SEARCH_ROOTS ?? '';
  return { home, searchRoots: parseSearchRoots(raw, home) };
}

function isWithin(dir: string, root: string): boolean {
  if (dir === root) return true;
  return dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

function hasMarker(dir: string): boolean {
  return existsSync(join(dir, MARKER_RELATIVE_PATH));
}

// A home folder that is itself a repo (dotfiles) is not a project root: it
// would fold every non-git project under it into one.
export function findGitRoot(start: string, home: string = resolve(homedir())): string | null {
  let dir = resolve(start);
  for (;;) {
    if (dir === home) return null;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function linkedGitDir(gitRoot: string): string | null {
  const dotGit = join(gitRoot, '.git');
  try {
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf-8'));
    return match ? resolve(gitRoot, match[1]) : null;
  } catch {
    return null;
  }
}

function commonGitDir(gitDir: string): string | null {
  try {
    return resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim());
  } catch {
    return null;
  }
}

// Only a linked worktree's private git dir has a `commondir` file; a
// submodule's (.git/modules/<name>) does not, so a submodule stays its own
// project. A common dir not named `.git` belongs to a bare repo, which has no
// main checkout to share.
export function mainWorktreeRoot(gitRoot: string): string | null {
  const gitDir = linkedGitDir(gitRoot);
  if (!gitDir) return null;
  const common = commonGitDir(gitDir);
  if (!common || basename(common) !== '.git') return null;
  try {
    if (!statSync(common).isDirectory()) return null;
  } catch {
    return null;
  }
  const main = dirname(common);
  return main === gitRoot ? null : main;
}

export function gitInfoExcludePath(gitRoot: string): string | null {
  const dotGit = join(gitRoot, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'info', 'exclude');
  } catch {
    return null;
  }
  const gitDir = linkedGitDir(gitRoot);
  if (!gitDir) return null;
  return join(commonGitDir(gitDir) ?? gitDir, 'info', 'exclude');
}

function chooseBoundary(start: string, env: ResolutionEnv, gitRoot: string | null): WalkBoundary {
  const containing = env.searchRoots
    .filter((root) => isWithin(start, root))
    .sort((a, b) => b.length - a.length)[0];
  if (containing) return { kind: 'search-root', dir: containing };
  if (env.searchRoots.length === 0 && start !== env.home && isWithin(start, env.home)) {
    return { kind: 'home', dir: env.home };
  }
  return { kind: 'repo', dir: gitRoot ?? start };
}

// The start folder is always checked, so a folder with its own marker keeps
// its project. Above it, a home boundary is never checked itself: a marker
// directly in the home folder would claim every project on the machine.
function walkToMarker(start: string, boundary: WalkBoundary): string | null {
  let dir = start;
  for (;;) {
    if (dir !== start && boundary.kind === 'home' && dir === boundary.dir) return null;
    if (hasMarker(dir)) return dir;
    if (dir === boundary.dir) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProjectLocation(cwd: string, env: ResolutionEnv = defaultResolutionEnv()): ProjectLocation {
  const folder = resolve(cwd);
  const home = resolve(env.home);
  const resolvedEnv = { ...env, home };
  const gitRoot = findGitRoot(folder, home);
  const boundary = chooseBoundary(folder, resolvedEnv, gitRoot);
  const found = walkToMarker(folder, boundary);
  if (found) return { folder, root: found, markerFound: true, reason: 'marker', boundary, gitRoot };

  const mainRoot = gitRoot ? mainWorktreeRoot(gitRoot) : null;
  if (mainRoot) {
    const main = resolveProjectLocation(mainRoot, resolvedEnv);
    return {
      folder, root: main.root, markerFound: main.markerFound, reason: 'main-worktree',
      boundary, gitRoot, mainWorktree: mainRoot, main,
    };
  }

  const root = gitRoot ?? folder;
  return { folder, root, markerFound: hasMarker(root), reason: gitRoot ? 'git-root' : 'folder', boundary, gitRoot };
}
