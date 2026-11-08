import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';
import { runProjectsCommand, type ProjectsCommandDeps } from '../../../src/npx-cli/commands/projects.js';
import { planPrune, executePrune } from '../../../src/services/projects/prune.js';
import type { ProjectEntry, ProjectInventory, RecordStats } from '../../../src/services/projects/inventory.js';
import type { DatabaseCensus } from '../../../src/services/projects/projects-db.js';

const EMPTY = '11111111-1111-1111-1111-111111111111';
const KEEP = '22222222-2222-2222-2222-222222222222';
const msp = (id: string) => `msp_${id.replace(/-/g, '')}`;
const stats = (events: number): RecordStats => ({ observations: 0, notes: 0, events, sessions: 0, lastActivity: null });
const clean: DatabaseCensus = { tables: { teams: 1, projects: 1 }, accountRows: 0, dataRows: 0, foreignRows: 0, newestRowAt: null };

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'ms-prune-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(o: Partial<ProjectEntry>): ProjectEntry {
  return {
    projectId: EMPTY, teamId: 't-empty', name: 'scratch', team: 'local', runtime: 'local', folders: [],
    recordedPath: '/gone/scratch', databaseName: msp(EMPTY), counts: stats(0), lastActivity: null, flags: ['empty'],
    teamMarkerFolders: [], ...o,
  };
}
const inv = (projects: ProjectEntry[], incompleteScans: string[] = []): ProjectInventory =>
  ({ accountDatabase: 'postgres', projects, strays: [], incompleteScans });
const census = (c: DatabaseCensus | null) => async () => c;

describe('CredentialStore.removeKeyForTeam', () => {
  it('removes one team key and keeps the others', () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('t-gone', 'k1');
    store.storeKeyForTeam('t-kept', 'k2');
    store.removeKeyForTeam('t-gone');
    expect(store.resolveKeyForTeam('t-gone')).toBeNull();
    expect(store.resolveKeyForTeam('t-kept')).toBe('k2');
  });
});

describe('planPrune', () => {
  it('offers an empty project whose whole database holds only its own hinge rows', async () => {
    const plan = await planPrune(inv([entry({})]), census(clean));
    expect(plan.candidates.map((c) => [c.reason, c.dropDatabase, c.deleteProject])).toEqual([['empty', msp(EMPTY), true]]);
  });

  it('keeps a database that holds account rows or any data row, whatever the project counts say', async () => {
    const withAccount = await planPrune(inv([entry({})]), census({ ...clean, accountRows: 2 }));
    expect(withAccount.candidates).toEqual([]);
    expect(withAccount.kept[0].reason).toContain('2 account rows');
    const withSessions = await planPrune(inv([entry({})]), census({ ...clean, dataRows: 3, tables: { server_sessions: 3 } }));
    expect(withSessions.candidates).toEqual([]);
    expect(withSessions.kept[0].reason).toContain('holds 3 rows');
  });

  it('keeps everything it cannot count', async () => {
    const unreadableCensus = await planPrune(inv([entry({})]), census(null));
    expect(unreadableCensus.kept[0].reason).toContain('could not count every table');
    const unknownCounts = await planPrune(inv([entry({ counts: null, flags: ['missing-db'], databaseName: null })]), census(clean));
    expect(unknownCounts.candidates).toEqual([]);
    expect(unknownCounts.kept[0].reason).toContain('could not count its records');
    const orphan = entry({ projectId: null, teamId: null, name: msp(KEEP), databaseName: msp(KEEP), counts: null, flags: ['orphan-db'] });
    expect((await planPrune(inv([orphan]), census(clean))).candidates).toEqual([]);
  });

  it('keeps an orphan database that holds records', async () => {
    const orphan = entry({ projectId: null, teamId: null, name: msp(KEEP), databaseName: msp(KEEP), counts: stats(4), flags: ['orphan-db'] });
    const plan = await planPrune(inv([orphan]), census(clean));
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].reason).toContain('holds 4 records');
  });

  it('keeps a project when no folder is recorded or a scan stopped early', async () => {
    expect((await planPrune(inv([entry({ recordedPath: null })]), census(clean))).kept[0].reason).toContain('no folder is recorded');
    expect((await planPrune(inv([entry({})], ['/w']), census(clean))).kept[0].reason).toContain('stopped early');
  });

  it('never offers a database another project also names', async () => {
    const other = entry({ projectId: KEEP, teamId: 't-keep', name: 'app', databaseName: msp(EMPTY), counts: stats(3), flags: [] });
    const plan = await planPrune(inv([entry({}), other]), census(clean));
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].reason).toContain('another project also uses');
  });

  it('keeps a merged project whose database has rows newer than the merge, and keeps the record of one it drops', async () => {
    const archived = entry({ flags: ['archived'], mergedInto: KEEP, archivedAt: '2026-11-01T00:00:00.000Z', counts: stats(5) });
    const newer = await planPrune(inv([archived]), census({ ...clean, dataRows: 9, newestRowAt: '2026-11-02T00:00:00.000Z' }));
    expect(newer.candidates).toEqual([]);
    expect(newer.kept[0].reason).toContain('after it was merged');
    const older = await planPrune(inv([archived]), census({ ...clean, dataRows: 9, newestRowAt: '2026-10-30T00:00:00.000Z' }));
    expect(older.candidates.map((c) => [c.reason, c.deleteProject])).toEqual([['archived', false]]);
  });
});

function fakeDb(opts: { known?: boolean; failDumpFor?: string; recount?: DatabaseCensus | null } = {}) {
  const statements: string[] = [];
  let censusCalls = 0;
  let released = 0;
  const recountConnections: unknown[] = [];
  const db = {
    accountDatabase: 'postgres',
    accountDatabaseKnown: opts.known ?? true,
    urlFor: (name: string) => `postgres://fake/${name}`,
    release: async () => {},
    close: async () => {},
    withMaintenanceLock: async <T>(fn: () => Promise<T>) => fn(),
    // The first count plans the prune; any later one is the recheck before the drop.
    census: async (_name: string, _owner: unknown, conn?: unknown) => {
      if (censusCalls > 0) recountConnections.push(conn);
      return censusCalls++ === 0 || opts.recount === undefined ? clean : opts.recount;
    },
    pool: () => ({ connect: async () => ({ query: async () => ({ rows: [{ pid: 4242 }] }), release: () => { released += 1; } }) }),
    accountRowsSql: async (projectId: string) => `INSERT INTO projects VALUES ('${projectId}');\n`,
    base: {
      query: async (sql: string) => {
        const statement = sql.replace(/\s+/g, ' ').trim();
        if (!statement.startsWith('SELECT 1 FROM pg_stat_activity')) statements.push(statement);
        return { rows: statement.startsWith('SELECT 1 FROM pg_stat_activity') ? [{ '?column?': 1 }] : [], rowCount: sql.startsWith('DELETE FROM teams') ? 1 : 0 };
      },
    },
    inventorySource: () => ({
      accountDatabase: 'postgres',
      listProjects: async () => [
        { id: EMPTY, teamId: 't-empty', name: 'scratch', metadata: { memsmith_project_path: join(dir, 'gone') } },
        { id: KEEP, teamId: 't-keep', name: 'app', metadata: {} },
      ],
      listDatabases: async () => ['postgres', msp(EMPTY), msp(KEEP)],
      recordStats: async (_db: string, id: string | null) => stats(id === KEEP ? 3 : 0),
    }),
  };
  return { db, statements, opts, recountConnections, released: () => released };
}

function deps(fake: ReturnType<typeof fakeDb>, out: string[], forgotten: string[]): ProjectsCommandDeps {
  return {
    cwd: dir,
    env: { home: dir, searchRoots: [] },
    runtime: () => 'local',
    openDb: () => fake.db as never,
    hasKeyForTeam: () => true,
    forgetTeamKey: (teamId) => forgotten.push(teamId),
    dump: async (url, file) => {
      if (fake.opts.failDumpFor && url.endsWith(fake.opts.failDumpFor)) throw new Error('pg_dump failed');
      const { writeFileSync } = await import('fs');
      writeFileSync(file, '-- dump\n');
    },
    backupDir: join(dir, 'backups'),
    now: () => new Date('2026-11-08T00:00:00Z'),
    out: (l) => out.push(l),
    err: (l) => out.push(l),
  };
}

describe('memsmith projects --prune --yes', () => {
  it('backs up the account rows and the database, drops it, forgets the team key, and asks for a restart', async () => {
    const fake = fakeDb();
    const out: string[] = [];
    const forgotten: string[] = [];
    expect(await runProjectsCommand(['--prune', '--yes'], deps(fake, out, forgotten))).toBe(0);
    expect(fake.statements).toEqual([
      `ALTER DATABASE "${msp(EMPTY)}" WITH ALLOW_CONNECTIONS false`,
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND pid <> $2 AND application_name <> 'pg_dump'",
      `DROP DATABASE IF EXISTS "${msp(EMPTY)}" WITH (FORCE)`,
      'DELETE FROM projects WHERE id = $1',
      'DELETE FROM teams WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM projects WHERE team_id = $1)',
    ]);
    expect(forgotten).toEqual(['t-empty']);
    expect(out).toContain('Run `memsmith restart` to release connections to dropped databases.');
    // The recount runs on the connection held from before connections were blocked.
    expect(fake.recountConnections).toHaveLength(1);
    expect(fake.recountConnections[0]).toBeDefined();
    expect(fake.released()).toBe(1);
    const accountBackup = join(dir, 'backups', `prune-${EMPTY}-account-2026-11-08T00-00-00-000Z.sql`);
    expect(readFileSync(accountBackup, 'utf-8')).toContain(EMPTY);
    expect(statSync(accountBackup).mode & 0o777).toBe(0o600);
  });

  it('keeps the database, the project, and the key when the backup fails', async () => {
    const fake = fakeDb({ failDumpFor: msp(EMPTY) });
    const out: string[] = [];
    const forgotten: string[] = [];
    expect(await runProjectsCommand(['--prune', '--yes'], deps(fake, out, forgotten))).toBe(1);
    expect(fake.statements).toEqual([]);
    expect(forgotten).toEqual([]);
    expect(out.join('\n')).not.toContain('memsmith restart');
  });

  it('stops before dropping when a recount right before the drop finds rows', async () => {
    const fake = fakeDb({ recount: { ...clean, dataRows: 1 } });
    const out: string[] = [];
    expect(await runProjectsCommand(['--prune', '--yes'], deps(fake, out, []))).toBe(1);
    expect(fake.statements).toEqual([
      `ALTER DATABASE "${msp(EMPTY)}" WITH ALLOW_CONNECTIONS false`,
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() AND pid <> $2 AND application_name <> 'pg_dump'",
      `ALTER DATABASE "${msp(EMPTY)}" WITH ALLOW_CONNECTIONS true`,
    ]);
    expect(out.join('\n')).toContain('changed after the preview');
  });

  it('refuses to prune when the account database is a guess', async () => {
    const fake = fakeDb({ known: false });
    const out: string[] = [];
    expect(await runProjectsCommand(['--prune'], deps(fake, out, []))).toBe(1);
    expect(out.join('\n')).toContain('Run `memsmith start` first');
    expect(fake.statements).toEqual([]);
  });

  it('refuses at the drop when another project names the database, even with a stale plan', async () => {
    const fake = fakeDb();
    const candidate = { entry: entry({}), reason: 'empty' as const, dropDatabase: msp(EMPTY), deleteProject: true };
    const outcomes = await executePrune(
      { db: fake.db as never, dump: async () => {}, backupDir: join(dir, 'b'), now: () => new Date(), forgetTeamKey: () => {} },
      { candidates: [candidate], kept: [], databaseOwners: new Map([[msp(EMPTY), [EMPTY, KEEP]]]) },
    );
    expect(outcomes[0].error).toContain('refusing to drop');
    expect(fake.statements).toEqual([]);
  });
});
