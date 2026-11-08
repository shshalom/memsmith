import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideMerge as decide, executeMerge, MergeStageError, resolveProjectRef } from '../../../src/services/projects/merge.js';
import type { ProjectEntry, ProjectInventory } from '../../../src/services/projects/inventory.js';

function entry(o: Partial<ProjectEntry> & { projectId: string; name: string }): ProjectEntry {
  return {
    teamId: `t-${o.projectId}`, team: 'local', runtime: 'local', folders: [], recordedPath: null, databaseName: `msp_${o.projectId}`,
    counts: null, lastActivity: null, flags: [], teamMarkerFolders: [], ...o,
  };
}

const root = entry({ projectId: 'p-root', name: 'app', folders: ['/w/app'] });
const nested = entry({ projectId: 'p-cli', name: 'cli', folders: ['/w/app/cli', '/w/app/tools'] });
const inventoryOf = (projects: ProjectEntry[]): ProjectInventory => ({ accountDatabase: 'postgres', projects, strays: [], incompleteScans: [] });
const decideMerge = (from: ProjectEntry, into: ProjectEntry, others: ProjectEntry[] = []) => decide(inventoryOf([from, into, ...others]), from, into);

describe('decideMerge', () => {
  it('repoints every folder that links to the source', () => {
    expect(decideMerge(nested, root)).toMatchObject({ refusal: null, repoint: ['/w/app/cli', '/w/app/tools'] });
  });

  it('refuses to merge a project into itself', () => {
    expect(decideMerge(root, root).refusal).toContain('same project');
  });

  it('refuses a team project on either side, including one known only by its marker', () => {
    const team = entry({ projectId: 'p-team', name: 'shared', runtime: 'team' });
    expect(decideMerge(team, root).refusal).toContain('shared is a team project');
    expect(decideMerge(root, team).refusal).toContain('shared is a team project');
    const markerOnly = entry({ projectId: 'p-m', name: 'm', teamMarkerFolders: ['/w/m'] });
    expect(decideMerge(markerOnly, root).refusal).toContain('team project');
  });

  it('refuses a source merged elsewhere but allows re-running the same merge', () => {
    expect(decideMerge({ ...nested, mergedInto: 'p-other' }, root).refusal).toContain('already merged into p-other');
    expect(decideMerge({ ...nested, mergedInto: 'p-root' }, root).refusal).toBeNull();
  });

  it('refuses a target that was itself merged away', () => {
    expect(decideMerge(nested, { ...root, mergedInto: 'p-x' }).refusal).toContain('Merge into that project instead');
  });

  it('refuses two projects that keep their records in the same database', () => {
    const legacy = entry({ projectId: 'p-legacy', name: 'legacy', databaseName: 'postgres' });
    const other = entry({ projectId: 'p-other', name: 'other', databaseName: 'postgres' });
    expect(decideMerge(legacy, other).refusal).toContain('same database (postgres)');
  });

  it('also repoints folders of a project merged into the source earlier', () => {
    const older = entry({ projectId: 'p-old', name: 'old', folders: ['/w/old'], mergedInto: 'p-cli' });
    const d = decideMerge(nested, root, [older]);
    expect(d.repoint).toEqual(['/w/app/cli', '/w/app/tools', '/w/old']);
    expect(d.repointProjectIds).toEqual(['p-cli', 'p-old']);
  });

  it('refuses a source whose earlier merge is still marked as in progress into another project', () => {
    expect(decideMerge({ ...nested, mergingInto: 'p-x' }, root).refusal).toContain('already merged into p-x');
    expect(decideMerge({ ...nested, mergingInto: 'p-root' }, root).refusal).toBeNull();
  });

  it('refuses when either side has no database', () => {
    expect(decideMerge({ ...nested, databaseName: null }, root).refusal).toContain('no records to merge');
    expect(decideMerge(nested, { ...root, databaseName: null }).refusal).toContain('has no database yet');
  });
});

describe('resolveProjectRef', () => {
  let home: string;
  beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'ms-ref-'))); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const inv = inventoryOf;

  it('finds a project by id, by name, and by folder', () => {
    const dir = join(home, 'cli');
    mkdirSync(join(dir, '.memsmith'), { recursive: true });
    writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: 't', projectId: 'p-cli' }));
    const ctx = { cwd: home, env: { home, searchRoots: [] } };
    expect(resolveProjectRef(inv([root, nested]), 'p-root', ctx)).toBe(root);
    expect(resolveProjectRef(inv([root, nested]), 'cli', ctx)).toBe(nested);
    expect(resolveProjectRef(inv([root, nested]), './cli', ctx)).toBe(nested);
  });

  it('lists the ids when a name is ambiguous', () => {
    const twin = entry({ projectId: 'p-twin', name: 'app' });
    const result = resolveProjectRef(inv([root, twin]), 'app', { cwd: home, env: { home, searchRoots: [] } });
    expect(result).toContain('More than one project is named app');
    expect(result).toContain('p-twin');
  });
});

describe('executeMerge', () => {
  const fakeDb = (touched: string[], known = true) => ({
    accountDatabaseKnown: known,
    urlFor: (name: string) => `postgres://x/${name}`,
    pool: (name: string) => { touched.push(name); throw new Error('pool opened'); },
    base: { query: async () => { touched.push('base'); return { rows: [] }; } },
    withMaintenanceLock: async <T>(fn: () => Promise<T>) => fn(),
  });

  it('stops before touching any database when the backup fails', async () => {
    const touched: string[] = [];
    const run = executeMerge(
      { db: fakeDb(touched) as never, dump: async () => { throw new Error('pg_dump exited with code 1'); }, backupDir: '/tmp/none', now: () => new Date() },
      decideMerge(nested, root),
    );
    await expect(run).rejects.toBeInstanceOf(MergeStageError);
    await expect(run).rejects.toMatchObject({ stage: 'backup', completed: [] });
    expect(touched).toEqual([]);
  });

  it('reports a failed catch-up cancel as the catch-up step, after the archive and markers finished', async () => {
    const report = (ids: string[]) => ({
      tables: Object.fromEntries(['server_sessions', 'agent_events', 'observation_generation_jobs', 'observations', 'observation_sources', 'observation_generation_job_events']
        .map((t) => [t, { source: 0, copy: 0, alreadyThere: 0, updated: 0, renamed: 0 }])),
      activeJobIds: ids, finishedJobsLeftBehind: 0, droppedColumns: {},
    });
    let cancels = 0;
    const db = {
      accountDatabaseKnown: true,
      urlFor: (name: string) => `postgres://x/${name}`,
      pool: () => ({}),
      base: { query: async () => ({ rows: [] }) },
      withMaintenanceLock: async <T>(fn: () => Promise<T>) => fn(),
    };
    const run = executeMerge(
      {
        db: db as never, dump: async () => {}, backupDir: '/tmp/none', now: () => new Date(),
        ops: {
          copy: async () => report(['j-late']) as never,
          cancel: async () => { cancels += 1; if (cancels === 2) throw new Error('connection lost'); return 1; },
        },
      },
      { ...decideMerge(nested, root), repoint: [] },
    );
    await expect(run).rejects.toMatchObject({ stage: 'catch-up', completed: ['backup', 'mark', 'copy', 'cancel-jobs', 'archive', 'markers'] });
  });

  it('refuses when the account database is a guess', async () => {
    const touched: string[] = [];
    let dumped = false;
    const run = executeMerge(
      { db: fakeDb(touched, false) as never, dump: async () => { dumped = true; }, backupDir: '/tmp/none', now: () => new Date() },
      decideMerge(nested, root),
    );
    await expect(run).rejects.toThrow('memsmith start');
    expect(dumped).toBe(false);
    expect(touched).toEqual([]);
  });
});
