import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readProjectMarker,
  resolveProjectRoot,
} from '../../../src/services/identity/project-identity.js';
import { parseSearchRoots, resolveProjectLocation } from '../../../src/services/identity/project-location.js';

// A user's ~/Workspace split into seven projects: inside a repo the marker
// lookup stopped at the repo root, so a workspace-level marker never counted.

function marker(dir: string, projectId: string, extra: object = {}) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n', ...extra }));
}

let home: string;
let workspace: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ms-home-')));
  workspace = join(home, 'Workspace');
  mkdirSync(join(workspace, 'MemSmith', '.git'), { recursive: true });
  mkdirSync(join(workspace, 'MemSmith', 'src', 'cli'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('configured search roots', () => {
  it('walks past the git root to a marker inside the search root', () => {
    marker(join(home, 'Workspace', 'team'), 'p-team');
    mkdirSync(join(workspace, 'team', 'app', '.git'), { recursive: true });
    mkdirSync(join(workspace, 'team', 'app', 'src'), { recursive: true });
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(workspace, 'team', 'app', 'src'), env)?.projectId).toBe('p-team');
  });

  it('counts a marker in the search root itself', () => {
    marker(workspace, 'p-ws');
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(workspace, 'MemSmith', 'src', 'cli'), env)?.projectId).toBe('p-ws');
    const location = resolveProjectLocation(join(workspace, 'MemSmith', 'src'), env);
    expect(location).toMatchObject({ root: workspace, markerFound: true, reason: 'marker', boundary: { kind: 'search-root', dir: workspace } });
  });

  it('never looks above the search root', () => {
    marker(home, 'p-home-level');
    marker(join(home, 'above'), 'p-above');
    const root = join(home, 'above', 'roots');
    mkdirSync(join(root, 'plain'), { recursive: true });
    const env = { home, searchRoots: [root] };
    expect(readProjectMarker(join(root, 'plain'), env)).toBeNull();
    expect(resolveProjectRoot(join(root, 'plain'), env)).toBe(join(root, 'plain'));
  });

  it('lets the nearest marker win over the search-root marker', () => {
    marker(workspace, 'p-ws');
    marker(join(workspace, 'MemSmith'), 'p-own');
    const env = { home, searchRoots: [workspace] };
    expect(readProjectMarker(join(workspace, 'MemSmith', 'src'), env)?.projectId).toBe('p-own');
  });

  it('turns off the home fallback for folders outside every configured root', () => {
    marker(workspace, 'p-ws');
    const env = { home, searchRoots: [join(home, 'Elsewhere')] };
    expect(resolveProjectRoot(join(workspace, 'MemSmith', 'src'), env)).toBe(join(workspace, 'MemSmith'));
    expect(readProjectMarker(join(workspace, 'MemSmith', 'src'), env)).toBeNull();
  });

  it('expands ~ and drops relative entries when parsing the setting', () => {
    expect(parseSearchRoots(' ~/Workspace , relative/dir,/opt/code/ ,', '/Users/ana')).toEqual(['/Users/ana/Workspace', '/opt/code']);
    expect(parseSearchRoots('', '/Users/ana')).toEqual([]);
  });
});

describe('home fallback when no search roots are configured', () => {
  it('walks up across git roots to a marker below home', () => {
    marker(workspace, 'p-ws');
    expect(readProjectMarker(join(workspace, 'MemSmith', 'src', 'cli'), { home, searchRoots: [] })?.projectId).toBe('p-ws');
  });

  it('never reads a marker in the home folder itself', () => {
    marker(home, 'p-home');
    const env = { home, searchRoots: [] };
    expect(readProjectMarker(join(workspace, 'MemSmith', 'src'), env)).toBeNull();
    expect(resolveProjectRoot(join(workspace, 'MemSmith', 'src'), env)).toBe(join(workspace, 'MemSmith'));
    const plain = join(home, 'notes');
    mkdirSync(plain);
    expect(resolveProjectRoot(plain, env)).toBe(plain);
  });
});

describe('folders outside the search scope', () => {
  it('keeps the old lookup: a scratch folder never walks up to its parent', () => {
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

  it('still stops at the git root outside the search scope', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ms-outside-')));
    try {
      marker(outside, 'p-parent');
      mkdirSync(join(outside, 'repo', '.git'), { recursive: true });
      mkdirSync(join(outside, 'repo', 'src'), { recursive: true });
      const env = { home, searchRoots: [] };
      expect(resolveProjectRoot(join(outside, 'repo', 'src'), env)).toBe(join(outside, 'repo'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
