import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readProjectMarker,
  resolveProjectRoot,
} from '../../../src/services/identity/project-identity.js';
import { parseSearchRoots, resolveProjectLocation } from '../../../src/services/identity/project-location.js';

// A user's ~/Workspace split into seven projects: inside a repo the marker
// lookup stopped at the repo root, so a workspace-level marker never counted.
// Crossing a git root is opt-in, through MEMSMITH_PROJECT_SEARCH_ROOTS.

function marker(dir: string, projectId: string, extra: object = {}) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n', ...extra }));
}

let home: string;
let workspace: string;
let repo: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ms-home-')));
  workspace = join(home, 'Workspace');
  repo = join(workspace, 'MemSmith');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src', 'cli'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('configured search roots', () => {
  it('walk past the git root to a marker inside the search root', () => {
    marker(join(workspace, 'team'), 'p-team');
    mkdirSync(join(workspace, 'team', 'app', '.git'), { recursive: true });
    mkdirSync(join(workspace, 'team', 'app', 'src'), { recursive: true });
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(workspace, 'team', 'app', 'src'), env)?.projectId).toBe('p-team');
    expect(resolveProjectLocation(join(workspace, 'team', 'app', 'src'), env).borrowed).toBe(true);
  });

  it('count a marker in the search root itself', () => {
    marker(workspace, 'p-ws');
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(repo, 'src', 'cli'), env)?.projectId).toBe('p-ws');
    expect(resolveProjectLocation(join(repo, 'src'), env)).toMatchObject({
      root: workspace, markerFound: true, reason: 'marker', boundary: { kind: 'search-root', dir: workspace },
    });
  });

  it('never look above the search root', () => {
    marker(join(home, 'above'), 'p-above');
    const root = join(home, 'above', 'roots');
    mkdirSync(join(root, 'plain'), { recursive: true });
    const env = { home, searchRoots: [root] };
    expect(readProjectMarker(join(root, 'plain'), env)).toBeNull();
    expect(resolveProjectRoot(join(root, 'plain'), env)).toBe(join(root, 'plain'));
  });

  it('let the nearest marker win over the search-root marker', () => {
    marker(workspace, 'p-ws');
    marker(repo, 'p-own');
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(repo, 'src'), env)?.projectId).toBe('p-own');
    expect(resolveProjectLocation(join(repo, 'src'), env).borrowed).toBe(false);
  });

  it('match a root given through a symlink', () => {
    marker(workspace, 'p-ws');
    const link = join(home, 'ws-link');
    symlinkSync(workspace, link);
    const { roots } = parseSearchRoots(link, home);
    expect(roots).toEqual([workspace]);
    expect(readProjectMarker(join(repo, 'src'), { home, searchRoots: roots })?.projectId).toBe('p-ws');
  });

  it.if(process.platform === 'darwin' || process.platform === 'win32')('ignore letter case on a case-insensitive file system', () => {
    marker(workspace, 'p-ws');
    const env = { home, searchRoots: [workspace.toUpperCase()] };
    expect(readProjectMarker(join(repo, 'src'), env)?.projectId).toBe('p-ws');
  });
});

describe('parsing the search-roots setting', () => {
  it('expands ~ and reports every entry it ignores', () => {
    const { roots, ignored } = parseSearchRoots(`~/Workspace, relative/dir, ~ana/code, ~, ${home}, ${join(home, 'missing')},`, home);
    expect(roots).toEqual([workspace]);
    expect(ignored.map((i) => i.entry)).toEqual(['relative/dir', '~ana/code', '~', home, join(home, 'missing')]);
    expect(ignored.find((i) => i.entry === '~')?.reason).toContain('home folder');
    expect(ignored.find((i) => i.entry === '~ana/code')?.reason).toContain('~');
  });

  it('returns nothing for an empty setting', () => {
    expect(parseSearchRoots('', home)).toEqual({ roots: [], ignored: [] });
  });
});

describe('without search roots', () => {
  it('stops at the git root, even with a workspace marker above it', () => {
    marker(workspace, 'p-ws');
    const env = { home, searchRoots: [] };
    expect(readProjectMarker(join(repo, 'src', 'cli'), env)).toBeNull();
    expect(resolveProjectRoot(join(repo, 'src', 'cli'), env)).toBe(repo);
  });

  it('walks a folder outside git up to a marker below home', () => {
    marker(workspace, 'p-ws');
    mkdirSync(join(workspace, 'notes', 'daily'), { recursive: true });
    const env = { home, searchRoots: [] };
    expect(readProjectMarker(join(workspace, 'notes', 'daily'), env)?.projectId).toBe('p-ws');
    expect(resolveProjectLocation(join(workspace, 'notes', 'daily'), env)).toMatchObject({ borrowed: true, boundary: { kind: 'home' } });
  });

  it('never reads a marker in the home folder itself', () => {
    marker(home, 'p-home');
    mkdirSync(join(home, 'notes'));
    const env = { home, searchRoots: [] };
    expect(readProjectMarker(join(home, 'notes'), env)).toBeNull();
    expect(resolveProjectRoot(join(home, 'notes'), env)).toBe(join(home, 'notes'));
  });

  it('keeps a scratch folder outside home to itself', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ms-outside-')));
    try {
      marker(outside, 'p-tmp');
      mkdirSync(join(outside, 'scratch'));
      const env = { home, searchRoots: [] };
      expect(resolveProjectRoot(join(outside, 'scratch'), env)).toBe(join(outside, 'scratch'));
      expect(readProjectMarker(join(outside, 'scratch'), env)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('with search roots that do not contain the folder', () => {
  it('turns off the home walk', () => {
    marker(workspace, 'p-ws');
    mkdirSync(join(workspace, 'notes'), { recursive: true });
    const env = { home, searchRoots: [join(home, 'Elsewhere')] };
    expect(readProjectMarker(join(workspace, 'notes'), env)).toBeNull();
  });
});
