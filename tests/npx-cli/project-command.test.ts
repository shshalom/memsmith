import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  projectSummary,
  runLinkCommand,
  runProjectCommand,
  type ProjectCommandDeps,
  type ServerProject,
} from '../../src/npx-cli/commands/project.js';

function marker(dir: string, body: object) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ note: 'n', ...body }));
}

function readMarker(dir: string) {
  return JSON.parse(readFileSync(join(dir, '.memsmith', 'project.json'), 'utf-8'));
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=a@example.com', '-c', 'user.name=a', ...args], { cwd, stdio: 'ignore' });
}

let home: string;
let workspace: string;
let repo: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ms-cli-home-')));
  workspace = join(home, 'Workspace');
  repo = join(workspace, 'MemSmith');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(cwd: string, over: Partial<ProjectCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const registered: string[] = [];
  let ids = 0;
  const d: ProjectCommandDeps = {
    cwd,
    env: { home, searchRoots: [] },
    newTeamId: () => `t-new-${ids + 1}`,
    newProjectId: () => `p-new-${++ids}`,
    hasKeyForTeam: (teamId) => teamId === 'team-joined',
    runtime: () => 'local',
    listProjects: async () => null,
    register: async (root) => { registered.push(root); return true; },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { d, out, err, registered, text: () => out.join('\n'), errors: () => err.join('\n') };
}

describe('memsmith project', () => {
  it('explains a marker found through a search root, with the server name and the roots', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws' });
    const servers: ServerProject[] = [{ projectId: 'p-ws', teamId: 'team-a', name: 'workspace-memory', runtime: 'local' }];
    const { d, text } = deps(join(repo, 'src'), { env: { home, searchRoots: [workspace] }, listProjects: async () => servers });
    expect(await runProjectCommand([], d)).toBe(0);
    expect(text()).toContain(`Folder:        ${join(repo, 'src')}`);
    expect(text()).toContain(`Project root:  ${workspace}`);
    expect(text()).toContain('Project:       workspace-memory (p-ws)');
    expect(text()).toContain('Team:          team-a (local)');
    expect(text()).toContain('Runtime:       local');
    expect(text()).toContain('Resolved by:   marker in ~/Workspace (search root ~/Workspace)');
    expect(text()).toContain('Search roots:  ~/Workspace');
  });

  it('warns about search-root entries it ignored', async () => {
    const { d, errors, text } = deps(repo, {
      env: { home, searchRoots: [], ignoredSearchRoots: [{ entry: '~', reason: 'your home folder cannot be a search root' }] },
    });
    await runProjectCommand([], d);
    expect(errors()).toContain('Ignored search root ~: your home folder cannot be a search root.');
    expect(text()).toContain('Search roots:  none');
  });

  it('falls back to the folder name when the server is not running', async () => {
    marker(repo, { teamId: 'team-a', projectId: 'p-repo' });
    const { d, text } = deps(join(repo, 'src'));
    await runProjectCommand([], d);
    expect(text()).toContain('Project:       MemSmith (p-repo)');
    expect(text()).toContain('Resolved by:   marker in ~/Workspace/MemSmith (git root)');
  });

  it('explains a marker reached by the home walk from a folder outside git', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws' });
    mkdirSync(join(workspace, 'notes'));
    const { d, text } = deps(join(workspace, 'notes'));
    await runProjectCommand([], d);
    expect(text()).toContain('Resolved by:   marker in ~/Workspace (searched up to your home folder)');
  });

  it('explains a joined team project', async () => {
    marker(repo, { teamId: 'team-joined', projectId: 'p-team', runtime: 'server', serverUrl: 'https://team.example' });
    const { d, text } = deps(repo, { runtime: () => 'server' });
    await runProjectCommand([], d);
    expect(text()).toContain('Team:          team-joined (joined team at https://team.example)');
    expect(text()).toContain('Runtime:       server');
  });

  it('explains a repository with no project yet, even under a workspace marker', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws' });
    const { d, text } = deps(join(repo, 'src'));
    expect(await runProjectCommand([], d)).toBe(0);
    expect(text()).toContain(`Project root:  ${repo}`);
    expect(text()).toContain('Project:       none');
    expect(text()).toContain('Resolved by:   no project yet: a session here will create one (git root)');
  });

  it('explains a worktree that shares the main checkout', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ms-cli-wt-')));
    try {
      const main = join(base, 'main');
      mkdirSync(main);
      writeFileSync(join(main, 'a'), 'a');
      git(main, 'init', '-q'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'i');
      git(main, 'worktree', 'add', '-q', join(base, 'wt'), '-b', 'wt');
      marker(main, { teamId: 'team-a', projectId: 'p-main' });
      const { d, text } = deps(join(base, 'wt'));
      await runProjectCommand([], d);
      expect(text()).toContain(`Project root:  ${main}`);
      expect(text()).toContain(`Resolved by:   main worktree ${main}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('memsmith link', () => {
  it('pins the project the folder resolves to and excludes the marker from git', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws', databaseName: 'msp_ws' });
    const { d, registered } = deps(join(repo, 'src'), { env: { home, searchRoots: [workspace] } });
    expect(await runLinkCommand([], d)).toBe(0);
    expect(readMarker(repo)).toMatchObject({ teamId: 'team-a', projectId: 'p-ws', databaseName: 'msp_ws' });
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toContain('.memsmith/*');
    expect(registered).toEqual([repo]);
  });

  it('creates a project with a team of its own when the folder resolves to nothing', async () => {
    const { d, text } = deps(repo);
    expect(await runLinkCommand([], d)).toBe(0);
    expect(readMarker(repo)).toMatchObject({ teamId: 't-new-1', projectId: 'p-new-1' });
    expect(text()).toContain('MemSmith created project MemSmith (p-new-1)');
  });

  it('adds the git exclude entry once, and treats an existing .memsmith entry as present', async () => {
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
    const { d } = deps(repo);
    await runLinkCommand([], d);
    await runLinkCommand([], d);
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8').split('\n');
    expect(lines.filter((l) => l === '.memsmith/*').length).toBe(1);
    expect(lines[0]).toStartWith('# git ls-files');
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);

    for (const entry of ['.memsmith', '.memsmith/']) {
      writeFileSync(join(repo, '.git', 'info', 'exclude'), `${entry}\n`);
      await runLinkCommand([], deps(repo).d);
      expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toBe(`${entry}\n`);
    }
  });

  it('ignores the marker in git, and still lets a convert share it', async () => {
    const real = join(home, 'real');
    mkdirSync(real);
    git(real, 'init', '-q');
    const { d } = deps(real);
    expect(await runLinkCommand([], d)).toBe(0);
    const ignored = (path: string) => spawnSync('git', ['check-ignore', '-q', path], { cwd: real }).status === 0;
    expect(ignored('.memsmith/project.json')).toBe(true);
    writeFileSync(join(real, '.gitignore'), '!.memsmith/project.json\n');
    expect(ignored('.memsmith/project.json')).toBe(false);
  });

  it('links to a project id the server knows', async () => {
    const servers: ServerProject[] = [{ projectId: 'p-other', teamId: 'team-a', name: 'other', runtime: 'local' }];
    const { d } = deps(repo, { listProjects: async () => servers });
    expect(await runLinkCommand(['p-other'], d)).toBe(0);
    expect(readMarker(repo)).toMatchObject({ teamId: 'team-a', projectId: 'p-other' });
  });

  it('reads a bare word as a project name even when a subfolder has that name', async () => {
    mkdirSync(join(repo, 'api'));
    const servers: ServerProject[] = [{ projectId: 'p-api', teamId: 'team-a', name: 'api', runtime: 'local' }];
    const { d } = deps(repo, { listProjects: async () => servers });
    expect(await runLinkCommand(['api'], d)).toBe(0);
    expect(readMarker(repo).projectId).toBe('p-api');
  });

  it('links to a project name, and refuses an ambiguous one', async () => {
    const servers: ServerProject[] = [
      { projectId: 'p-1', teamId: 'team-a', name: 'api', runtime: 'local' },
      { projectId: 'p-2', teamId: 'team-a', name: 'web', runtime: 'local' },
      { projectId: 'p-3', teamId: 'team-x', name: 'web', runtime: 'local' },
    ];
    const one = deps(repo, { listProjects: async () => servers });
    expect(await runLinkCommand(['api'], one.d)).toBe(0);
    expect(readMarker(repo).projectId).toBe('p-1');

    rmSync(join(repo, '.memsmith'), { recursive: true });
    const two = deps(repo, { listProjects: async () => servers });
    expect(await runLinkCommand(['web'], two.d)).toBe(1);
    expect(two.errors()).toContain('More than one project is named web');
    expect(two.errors()).toContain('p-2');
    expect(two.errors()).toContain('p-3');
    expect(existsSync(join(repo, '.memsmith', 'project.json'))).toBe(false);
  });

  it('says the server must run to look up a name or id', async () => {
    const { d, errors } = deps(repo);
    expect(await runLinkCommand(['api'], d)).toBe(1);
    expect(errors()).toContain('memsmith start');
  });

  it('links to another folder by path', async () => {
    const other = join(workspace, 'other');
    marker(other, { teamId: 'team-joined', projectId: 'p-other', runtime: 'server', serverUrl: 'https://team.example' });
    const { d } = deps(repo);
    expect(await runLinkCommand(['../other'], d)).toBe(0);
    expect(readMarker(repo)).toMatchObject({ teamId: 'team-joined', projectId: 'p-other', runtime: 'server', serverUrl: 'https://team.example' });
  });

  it('creates a fresh project with --new even when a parent resolves to one', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws' });
    const { d } = deps(join(repo, 'src'), { env: { home, searchRoots: [workspace] } });
    expect(await runLinkCommand(['--new'], d)).toBe(0);
    expect(readMarker(repo)).toMatchObject({ teamId: 't-new-1', projectId: 'p-new-1' });
    expect(readMarker(workspace).projectId).toBe('p-ws');
  });

  it('refuses to repoint an existing marker without --force, and shows the change', async () => {
    marker(repo, { teamId: 'team-a', projectId: 'p-repo' });
    const { d, errors } = deps(repo);
    expect(await runLinkCommand(['--new'], d)).toBe(1);
    expect(errors()).toContain('p-repo');
    expect(errors()).toContain('p-new-1');
    expect(errors()).toContain('--force');
    expect(readMarker(repo).projectId).toBe('p-repo');

    const forced = deps(repo);
    expect(await runLinkCommand(['--new', '--force'], forced.d)).toBe(0);
    expect(readMarker(repo).projectId).toBe('p-new-1');
  });

  it('treats a different team server as a different link', async () => {
    const other = join(workspace, 'other');
    marker(other, { teamId: 'team-joined', projectId: 'p-team', runtime: 'server', serverUrl: 'https://new.example' });
    marker(repo, { teamId: 'team-joined', projectId: 'p-team', runtime: 'server', serverUrl: 'https://old.example' });
    const { d, errors } = deps(repo);
    expect(await runLinkCommand(['../other'], d)).toBe(1);
    expect(errors()).toContain('https://old.example');
    expect(errors()).toContain('https://new.example');
  });

  it('never turns a team marker into a local one, even with --force', async () => {
    marker(repo, { teamId: 'team-joined', projectId: 'p-team', runtime: 'server', serverUrl: 'https://team.example' });
    const { d, errors } = deps(repo);
    expect(await runLinkCommand(['--new', '--force'], d)).toBe(1);
    expect(errors()).toContain('team');
    expect(readMarker(repo).projectId).toBe('p-team');
  });

  it('refuses to link the home folder itself', async () => {
    const { d, errors } = deps(home);
    expect(await runLinkCommand(['--new'], d)).toBe(1);
    expect(errors()).toContain('home folder');
    expect(existsSync(join(home, '.memsmith'))).toBe(false);
  });

  it('never writes a key into the marker', async () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws', apiKey: 'msk_secret' });
    const { d } = deps(join(repo, 'src'), { env: { home, searchRoots: [workspace] } });
    await runLinkCommand([], d);
    expect(readFileSync(join(repo, '.memsmith', 'project.json'), 'utf-8')).not.toContain('msk_secret');
  });

  it('reports a server that could not register the project', async () => {
    const { d, errors } = deps(repo, { register: async () => false });
    expect(await runLinkCommand([], d)).toBe(0);
    expect(errors()).toContain('next session');
  });
});

describe('the status summary', () => {
  it('names the project and why it resolved there', () => {
    marker(workspace, { teamId: 'team-a', projectId: 'p-ws' });
    expect(projectSummary(join(repo, 'src'), { home, searchRoots: [workspace] }))
      .toBe('Workspace (p-ws), marker in ~/Workspace (search root ~/Workspace)');
  });

  it('says when a folder has no project yet', () => {
    expect(projectSummary(repo, { home, searchRoots: [] }))
      .toBe('none yet; a session here creates one');
  });
});
