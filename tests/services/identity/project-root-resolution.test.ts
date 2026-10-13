import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ensureProjectIdentity,
  readProjectMarker,
  resolveProjectRoot,
} from '../../../src/services/identity/project-identity.js';

// Starting Claude in repo/ios and later in repo used to mint two unrelated
// identities (different teams, databases, and memory), because identity was
// read only from the exact session directory.

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

function marker(dir: string, teamId: string, projectId: string, extra: object = {}) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId, projectId, note: 'n', ...extra }));
}

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'ms-root-')));
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'ios', 'App'), { recursive: true });
  mkdirSync(join(repo, 'android'), { recursive: true });
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('resolveProjectRoot', () => {
  it('puts a new identity at the git root when the session starts in a subfolder', () => {
    expect(resolveProjectRoot(join(repo, 'ios', 'App'))).toBe(repo);
  });

  it('finds the root identity from a subfolder', () => {
    marker(repo, 't-root', 'p-root');
    expect(readProjectMarker(join(repo, 'ios'))?.projectId).toBe('p-root');
  });

  it('honours a nearer subfolder identity over the root one', () => {
    marker(repo, 't-root', 'p-root');
    marker(join(repo, 'ios'), 't-ios', 'p-ios');
    expect(readProjectMarker(join(repo, 'ios', 'App'))?.projectId).toBe('p-ios');
    expect(readProjectMarker(join(repo, 'android'))?.projectId).toBe('p-root');
  });

  it('keeps the session directory as the root outside git', () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'ms-plain-')));
    try {
      mkdirSync(join(plain, 'sub'));
      expect(resolveProjectRoot(join(plain, 'sub'))).toBe(join(plain, 'sub'));
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('treats a submodule as its own project', () => {
    const sub = join(repo, 'vendored');
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/vendored');
    marker(repo, 't-root', 'p-root');
    expect(resolveProjectRoot(sub)).toBe(sub);
  });
});

describe('ensureProjectIdentity from a subfolder', () => {
  it('mints one identity at the git root that the root session also uses', async () => {
    const fromIos = await ensureProjectIdentity(fakePool as any, join(repo, 'ios'));
    expect(existsSync(join(repo, '.memsmith', 'project.json'))).toBe(true);
    expect(existsSync(join(repo, 'ios', '.memsmith'))).toBe(false);
    const fromRoot = await ensureProjectIdentity(fakePool as any, repo);
    expect(fromRoot).toEqual(fromIos);
  });

  it('adopts the only existing subfolder identity and leaves a single marker', async () => {
    marker(join(repo, 'ios'), 't-ios', 'p-ios', { databaseName: 'msp_ios' });
    const ids = await ensureProjectIdentity(fakePool as any, repo);
    expect(ids).toEqual({ teamId: 't-ios', projectId: 'p-ios' });
    const rootMarker = JSON.parse(readFileSync(join(repo, '.memsmith', 'project.json'), 'utf-8'));
    expect(rootMarker.databaseName).toBe('msp_ios');
    // A leftover copy in ios/ would shadow the root marker and drift on join.
    expect(existsSync(join(repo, 'ios', '.memsmith', 'project.json'))).toBe(false);
    expect(resolveProjectRoot(join(repo, 'ios'))).toBe(repo);
  });

  it('never adopts a team identity from a subfolder', async () => {
    marker(join(repo, 'ios'), 't-team', 'p-team', { runtime: 'server', serverUrl: 'https://team.example' });
    const ids = await ensureProjectIdentity(fakePool as any, repo);
    expect(ids.projectId).not.toBe('p-team');
  });

  it('never adopts the identity of a nested repo or submodule', async () => {
    const sub = join(repo, 'vendored');
    mkdirSync(sub);
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/vendored');
    marker(sub, 't-sub', 'p-sub');
    const ids = await ensureProjectIdentity(fakePool as any, repo);
    expect(ids.projectId).not.toBe('p-sub');
  });

  it('never adopts a nested project from a folder that is not a repo', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ms-ws-')));
    try {
      const foo = join(workspace, 'foo');
      mkdirSync(join(foo, '.git'), { recursive: true });
      marker(foo, 't-foo', 'p-foo');
      const ids = await ensureProjectIdentity(fakePool as any, workspace);
      expect(ids.projectId).not.toBe('p-foo');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('mints a separate root identity when several subfolder identities exist', async () => {
    marker(join(repo, 'ios'), 't-ios', 'p-ios');
    marker(join(repo, 'android'), 't-and', 'p-and');
    const ids = await ensureProjectIdentity(fakePool as any, repo);
    expect(['p-ios', 'p-and']).not.toContain(ids.projectId);
  });
});
