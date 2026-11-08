// SPDX-License-Identifier: Apache-2.0
//
// Hooks run this on every session start and tool call, so it reads files only
// and never spawns git (tests/services/identity/project-worktree.test.ts).

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { readFlatSettings } from '../../shared/flat-settings.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export const MARKER_RELATIVE_PATH = '.memsmith/project.json';
export const SEARCH_ROOTS_SETTING = 'MEMSMITH_PROJECT_SEARCH_ROOTS' as const;

export interface IgnoredSearchRoot { entry: string; reason: string }

export interface ResolutionEnv {
  home: string;
  searchRoots: string[];
  ignoredSearchRoots?: IgnoredSearchRoot[];
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
  /** The project's marker lives above this folder's own git root (or the folder, outside git). */
  borrowed: boolean;
  mainWorktree?: string;
  main?: ProjectLocation;
}

const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function fold(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

export function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

function isWithin(dir: string, root: string): boolean {
  if (samePath(dir, root)) return true;
  return fold(dir).startsWith(fold(root.endsWith(sep) ? root : root + sep));
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function parseSearchRoots(raw: string, home: string): { roots: string[]; ignored: IgnoredSearchRoot[] } {
  const canonicalHome = canonicalPath(home);
  const roots: string[] = [];
  const ignored: IgnoredSearchRoot[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (/^~[^/\\]/.test(trimmed)) {
      ignored.push({ entry: trimmed, reason: 'only ~ for your own home folder is supported' });
      continue;
    }
    const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? join(home, trimmed.slice(2)) : trimmed;
    if (!isAbsolute(expanded)) {
      ignored.push({ entry: trimmed, reason: 'not an absolute path' });
      continue;
    }
    if (!existsSync(expanded)) {
      ignored.push({ entry: trimmed, reason: 'folder does not exist' });
      continue;
    }
    const root = canonicalPath(expanded);
    if (samePath(root, canonicalHome)) {
      ignored.push({ entry: trimmed, reason: 'your home folder cannot be a search root' });
      continue;
    }
    roots.push(root);
  }
  return { roots, ignored };
}

/** Reads the settings file now, for long-lived processes whose cached settings may be stale. */
export function freshResolutionEnv(settingsPath: string = USER_SETTINGS_PATH): ResolutionEnv {
  const home = canonicalPath(homedir());
  let raw = process.env[SEARCH_ROOTS_SETTING];
  if (raw === undefined) {
    try {
      const value = readFlatSettings(settingsPath)?.[SEARCH_ROOTS_SETTING];
      raw = typeof value === 'string' ? value : '';
    } catch {
      raw = '';
    }
  }
  const { roots, ignored } = parseSearchRoots(raw, home);
  return { home, searchRoots: roots, ignoredSearchRoots: ignored };
}

export function defaultResolutionEnv(): ResolutionEnv {
  const home = canonicalPath(homedir());
  const raw = process.env[SEARCH_ROOTS_SETTING] ?? loadFromFileOnce().MEMSMITH_PROJECT_SEARCH_ROOTS ?? '';
  const { roots, ignored } = parseSearchRoots(raw, home);
  return { home, searchRoots: roots, ignoredSearchRoots: ignored };
}

function hasMarker(dir: string): boolean {
  return existsSync(join(dir, MARKER_RELATIVE_PATH));
}

// A home folder that is itself a repo (dotfiles) is not a project root: it
// would fold every non-git project under it into one.
export function findGitRoot(start: string, home: string = canonicalPath(homedir())): string | null {
  let dir = resolve(start);
  for (;;) {
    if (samePath(dir, home)) return null;
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
    return match ? canonicalPath(resolve(gitRoot, match[1])) : null;
  } catch {
    return null;
  }
}

function commonGitDir(gitDir: string): string | null {
  try {
    return canonicalPath(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf-8').trim()));
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readGitConfig(common: string): string {
  try {
    return readFileSync(join(common, 'config'), 'utf-8');
  } catch {
    return '';
  }
}

// The common git dir records no path back to its main checkout. In the default
// layout the checkout is its parent, whose `.git` is the common dir itself.
// Otherwise only `core.worktree` names it; with `git init --separate-git-dir`
// and no core.worktree there is no reliable answer, so the worktree keeps its
// own project.
function checkoutForCommonDir(common: string): string | null {
  const config = readGitConfig(common);
  const bare = /^\s*bare\s*=\s*true\s*$/im.test(config);
  const parent = dirname(common);
  if (!bare && isDirectory(join(parent, '.git')) && samePath(canonicalPath(join(parent, '.git')), common)) return parent;
  const configured = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config)?.[1];
  if (!configured) return null;
  const worktree = canonicalPath(resolve(common, configured));
  const pointsBack = linkedGitDir(worktree) === common || samePath(canonicalPath(join(worktree, '.git')), common);
  return pointsBack ? worktree : null;
}

// Only a linked worktree's private git dir has a `commondir` file; a
// submodule's (.git/modules/<name>) does not, so a submodule stays its own
// project.
export function mainWorktreeRoot(gitRoot: string): string | null {
  const gitDir = linkedGitDir(gitRoot);
  if (!gitDir) return null;
  const common = commonGitDir(gitDir);
  if (!common || !isDirectory(common)) return null;
  const main = checkoutForCommonDir(common);
  return main && !samePath(main, gitRoot) ? main : null;
}

export function gitInfoExcludePath(gitRoot: string): string | null {
  const dotGit = join(gitRoot, '.git');
  if (isDirectory(dotGit)) return join(dotGit, 'info', 'exclude');
  const gitDir = linkedGitDir(gitRoot);
  if (!gitDir) return null;
  return join(commonGitDir(gitDir) ?? gitDir, 'info', 'exclude');
}

// Checks `from`, then each parent up to and including `last`. A home boundary
// is never checked itself: a marker directly in the home folder would claim
// every project on the machine.
function walk(from: string, last: string, skipHome: string | null): string | null {
  let dir = from;
  for (;;) {
    if (skipHome && samePath(dir, skipHome)) return null;
    if (hasMarker(dir)) return dir;
    if (samePath(dir, last)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where a folder's project marker is, or where a new one goes.
 *
 * 1. The nearest marker between the folder and its git root (the folder
 *    alone outside git). The git root of the folder's repository always
 *    counts, even when a search root lies inside the repository.
 * 2. A linked worktree with no marker of its own uses its main checkout's
 *    project, before anything above it is considered.
 * 3. Inside a configured search root, the walk continues above the git root,
 *    up to and including the search root. With no search roots configured, a
 *    folder outside git walks up to just below the home folder. Nothing else
 *    crosses a git root.
 * 4. Otherwise the project root is the git root, or the folder outside git.
 */
export function resolveProjectLocation(cwd: string, env: ResolutionEnv = defaultResolutionEnv()): ProjectLocation {
  const folder = canonicalPath(cwd);
  const home = canonicalPath(env.home);
  const resolvedEnv: ResolutionEnv = { ...env, home };
  const gitRoot = findGitRoot(folder, home);
  const ownRoot = gitRoot ?? folder;
  const repo: WalkBoundary = { kind: 'repo', dir: ownRoot };

  const own = walk(folder, ownRoot, null);
  if (own) return { folder, root: own, markerFound: true, reason: 'marker', boundary: repo, gitRoot, borrowed: false };

  const mainRoot = gitRoot ? mainWorktreeRoot(gitRoot) : null;
  if (mainRoot) {
    const main = resolveProjectLocation(mainRoot, resolvedEnv);
    return {
      folder, root: main.root, markerFound: main.markerFound, reason: 'main-worktree',
      boundary: repo, gitRoot, borrowed: true, mainWorktree: mainRoot, main,
    };
  }

  const above = dirname(ownRoot);
  const searchRoot = env.searchRoots
    .map(canonicalPath)
    .filter((root) => isWithin(folder, root))
    .sort((a, b) => b.length - a.length)[0];
  let boundary: WalkBoundary | null = null;
  if (searchRoot) {
    if (!samePath(ownRoot, searchRoot) && isWithin(ownRoot, searchRoot)) boundary = { kind: 'search-root', dir: searchRoot };
  } else if (env.searchRoots.length === 0 && !gitRoot && !samePath(folder, home) && isWithin(folder, home)) {
    boundary = { kind: 'home', dir: home };
  }
  if (boundary && above !== ownRoot) {
    const found = walk(above, boundary.dir, boundary.kind === 'home' ? home : null);
    if (found) return { folder, root: found, markerFound: true, reason: 'marker', boundary, gitRoot, borrowed: true };
  }

  return {
    folder, root: ownRoot, markerFound: false, reason: gitRoot ? 'git-root' : 'folder',
    boundary: boundary ?? repo, gitRoot, borrowed: false,
  };
}
