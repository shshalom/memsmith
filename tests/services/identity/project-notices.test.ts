import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';
import { projectNoticeFor } from '../../../src/services/identity/project-notices.js';

// A session that picked up a project from above its own folder, or created
// one, used to do it silently.

const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

function marker(dir: string, projectId: string) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n' }));
}

let base: string;
let dataDir: string;
const notHome = () => join(base, 'not-home');

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ms-notices-')));
  dataDir = join(base, 'data');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the created-project notice', () => {
  it('is reported only by the call that created the project, in a team of its own', async () => {
    const folder = join(base, 'fresh');
    const other = join(base, 'other');
    mkdirSync(folder);
    mkdirSync(other);
    const first = await ensureProjectIdentity(fakePool as never, folder);
    expect(first.created).toEqual({ root: folder, name: 'fresh' });
    expect((await ensureProjectIdentity(fakePool as never, folder)).created).toBeUndefined();
    const second = await ensureProjectIdentity(fakePool as never, other);
    expect(second.teamId).not.toBe(first.teamId);

    const notice = projectNoticeFor(folder, first, { dataDir });
    expect(notice).toBe(`MemSmith created project fresh for ${folder}. Run \`memsmith project\` to check it, or \`memsmith link\` to use a different project.`);
  });
});

describe('the borrowed-project notice', () => {
  it('names the project above the folder, once per folder', () => {
    const ws = join(base, 'ws');
    const repo = join(ws, 'api');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    marker(ws, 'p-ws');
    const env = { home: notHome(), searchRoots: [ws] };
    const first = projectNoticeFor(join(repo, 'src'), { projectId: 'p-ws' }, { env, dataDir });
    expect(first).toBe(`MemSmith is using project ws from ${ws} for this folder. Run \`memsmith project\` to check it, or \`memsmith link --new\` to give this folder its own project.`);
    expect(projectNoticeFor(repo, { projectId: 'p-ws' }, { env, dataDir })).toBeNull();
    expect(projectNoticeFor(join(repo, 'src'), null, { env, dataDir })).toBeNull();
  });

  it('shows again for a different folder', () => {
    const ws = join(base, 'ws');
    for (const name of ['api', 'web']) mkdirSync(join(ws, name, '.git'), { recursive: true });
    marker(ws, 'p-ws');
    const env = { home: notHome(), searchRoots: [ws] };
    expect(projectNoticeFor(join(ws, 'api'), null, { env, dataDir })).not.toBeNull();
    expect(projectNoticeFor(join(ws, 'web'), null, { env, dataDir })).not.toBeNull();
  });

  it('covers a worktree that shares its main checkout', () => {
    const main = join(base, 'main');
    mkdirSync(main);
    writeFileSync(join(main, 'a.txt'), 'a');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=a', ...a], { cwd: main, stdio: 'ignore' });
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'i');
    git('worktree', 'add', '-q', join(base, 'wt'), '-b', 'wt');
    marker(main, 'p-main');
    const env = { home: notHome(), searchRoots: [] };
    expect(projectNoticeFor(join(base, 'wt'), null, { env, dataDir })).toContain(`project main from ${main}`);
    expect(projectNoticeFor(join(base, 'wt'), null, { env, dataDir })).toBeNull();
  });

  it('stays silent for a folder that has its own marker', () => {
    const repo = join(base, 'own');
    mkdirSync(join(repo, '.git'), { recursive: true });
    marker(repo, 'p-own');
    expect(projectNoticeFor(repo, null, { env: { home: notHome(), searchRoots: [] }, dataDir })).toBeNull();
  });
});
