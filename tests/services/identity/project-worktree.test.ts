import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as childProcess from 'child_process';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureProjectIdentity,
  readProjectMarker,
  resolveProjectRoot,
} from '../../../src/services/identity/project-identity.js';
import { resolveProjectLocation } from '../../../src/services/identity/project-location.js';

// Every git worktree of one repo got its own project, so work done in a
// worktree never reached the main checkout's memory.

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
}

function marker(dir: string, projectId: string) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n' }));
}

let base: string;
let main: string;
let worktree: string;
const env = () => ({ home: join(base, 'not-home'), searchRoots: [] });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ms-wt-')));
  main = join(base, 'main');
  worktree = join(base, 'feature');
  mkdirSync(join(main, 'src'), { recursive: true });
  writeFileSync(join(main, 'src', 'a.txt'), 'a');
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'add', '.');
  git(main, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('linked git worktrees', () => {
  it('share the main checkout marker', () => {
    marker(main, 'p-main');
    expect(readProjectMarker(join(worktree, 'src'), env())?.projectId).toBe('p-main');
    expect(resolveProjectLocation(join(worktree, 'src'), env())).toMatchObject({
      root: main, markerFound: true, reason: 'main-worktree', mainWorktree: main,
    });
  });

  it('mint at the main worktree root so every worktree shares the project', async () => {
    const fromWorktree = await ensureProjectIdentity(fakePool as never, join(worktree, 'src'));
    expect(existsSync(join(main, '.memsmith', 'project.json'))).toBe(true);
    expect(existsSync(join(worktree, '.memsmith'))).toBe(false);
    const fromMain = await ensureProjectIdentity(fakePool as never, main);
    expect(fromMain.projectId).toBe(fromWorktree.projectId);
  });

  it('keep their own marker when they have one', () => {
    marker(main, 'p-main');
    marker(worktree, 'p-wt');
    expect(readProjectMarker(join(worktree, 'src'), env())?.projectId).toBe('p-wt');
  });

  it('resolve without spawning a child process', () => {
    marker(main, 'p-main');
    const spies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
      .map((name) => spyOn(childProcess, name));
    const bunSpawn = spyOn(Bun, 'spawn');
    const bunSpawnSync = spyOn(Bun, 'spawnSync');
    try {
      resolveProjectLocation(join(worktree, 'src'), env());
      resolveProjectRoot(join(worktree, 'src'), env());
      for (const spy of [...spies, bunSpawn, bunSpawnSync]) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of [...spies, bunSpawn, bunSpawnSync]) spy.mockRestore();
    }
  });
});

describe('a worktree next to its main checkout inside a workspace', () => {
  // ws/.memsmith=WS, ws/main/.memsmith=MAIN, ws/wt is a worktree of main. The
  // worktree walked up to ws before it ever looked at its main checkout.
  let ws: string;
  let wsMain: string;
  let wsWorktree: string;

  beforeEach(() => {
    ws = join(base, 'ws');
    wsMain = join(ws, 'main');
    wsWorktree = join(ws, 'wt');
    mkdirSync(wsMain, { recursive: true });
    writeFileSync(join(wsMain, 'a.txt'), 'a');
    git(wsMain, 'init', '-q');
    git(wsMain, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'add', '.');
    git(wsMain, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-qm', 'init');
    git(wsMain, 'worktree', 'add', '-q', wsWorktree, '-b', 'wt');
    marker(ws, 'p-ws');
    marker(wsMain, 'p-main');
  });

  it('uses the main checkout with no search roots', () => {
    expect(readProjectMarker(wsWorktree, { home: join(base, 'not-home'), searchRoots: [] })?.projectId).toBe('p-main');
  });

  it('uses the main checkout when the workspace is a search root', () => {
    expect(readProjectMarker(wsWorktree, { home: join(base, 'not-home'), searchRoots: [ws] })?.projectId).toBe('p-main');
  });

  it('uses the main checkout when the folder is under home', () => {
    expect(readProjectMarker(wsWorktree, { home: base, searchRoots: [] })?.projectId).toBe('p-main');
  });
});

describe('a main checkout in an unusual state', () => {
  it('is still shared when its first tracked file has an unstaged delete', () => {
    marker(main, 'p-main');
    rmSync(join(main, 'src', 'a.txt'));
    expect(readProjectMarker(worktree, env())?.projectId).toBe('p-main');
  });

  it('is still shared with a version 4 index', () => {
    marker(main, 'p-main');
    git(main, 'update-index', '--index-version', '4');
    expect(readProjectMarker(worktree, env())?.projectId).toBe('p-main');
  });
});

describe('a main checkout with a separate git dir', () => {
  // The common dir records no path back to a checkout created with
  // `git init --separate-git-dir`, so guessing would share the wrong project.
  let store: string;
  let checkout: string;
  let sepWorktree: string;

  beforeEach(() => {
    store = join(base, 'store');
    checkout = join(base, 'checkout');
    sepWorktree = join(base, 'sep-wt');
    mkdirSync(store);
    execFileSync('git', ['init', '-q', `--separate-git-dir=${join(store, 'repo.git')}`, checkout], { stdio: 'ignore' });
    writeFileSync(join(checkout, 'a.txt'), 'a');
    git(checkout, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'add', '.');
    git(checkout, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-qm', 'init');
    git(checkout, 'worktree', 'add', '-q', sepWorktree, '-b', 'sep');
    marker(checkout, 'p-checkout');
    marker(store, 'p-store');
  });

  it('is not guessed: the worktree keeps its own project root', () => {
    expect(resolveProjectRoot(sepWorktree, env())).toBe(sepWorktree);
    expect(readProjectMarker(sepWorktree, env())).toBeNull();
  });

  it('is shared when core.worktree names it', () => {
    execFileSync('git', ['config', '--file', join(store, 'repo.git', 'config'), 'core.worktree', checkout], { stdio: 'ignore' });
    expect(readProjectMarker(sepWorktree, env())?.projectId).toBe('p-checkout');
  });
});

describe('submodules', () => {
  it('are not treated as worktrees of the superproject', () => {
    marker(main, 'p-main');
    const sub = join(main, 'vendored');
    mkdirSync(join(main, '.git', 'modules', 'vendored'), { recursive: true });
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/vendored\n');
    expect(resolveProjectRoot(sub, env())).toBe(sub);
    expect(readProjectMarker(sub, env())).toBeNull();
  });
});
