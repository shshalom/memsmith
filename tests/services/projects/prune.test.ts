import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';
import { runProjectsCommand, type ProjectsCommandDeps } from '../../../src/npx-cli/commands/projects.js';
import type { RecordStats } from '../../../src/services/projects/inventory.js';

const EMPTY = '11111111-1111-1111-1111-111111111111';
const KEEP = '22222222-2222-2222-2222-222222222222';
const msp = (id: string) => `msp_${id.replace(/-/g, '')}`;
const stats = (events: number): RecordStats => ({ observations: 0, notes: 0, events, sessions: 0, lastActivity: null });

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'ms-prune-'))); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

function fakeDb(failDumpFor: string | null = null) {
  const statements: string[] = [];
  const db = {
    accountDatabase: 'postgres',
    urlFor: (name: string) => `postgres://fake/${name}`,
    release: async () => {},
    close: async () => {},
    base: {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [], rowCount: sql.startsWith('DELETE FROM teams') ? 1 : 0 };
      },
    },
    inventorySource: () => ({
      accountDatabase: 'postgres',
      listProjects: async () => [
        { id: EMPTY, teamId: 't-empty', name: 'scratch', metadata: {} },
        { id: KEEP, teamId: 't-keep', name: 'app', metadata: {} },
      ],
      listDatabases: async () => ['postgres', msp(EMPTY), msp(KEEP)],
      recordStats: async (_db: string, id: string | null) => stats(id === KEEP ? 3 : 0),
    }),
  };
  return { db, statements, failDumpFor };
}

function deps(fake: ReturnType<typeof fakeDb>, out: string[], forgotten: string[]): ProjectsCommandDeps {
  return {
    cwd: dir,
    env: { home: dir, searchRoots: [] },
    runtime: () => 'local',
    openDb: () => fake.db as never,
    hasKeyForTeam: () => true,
    forgetTeamKey: (teamId) => forgotten.push(teamId),
    dump: async (url) => { if (fake.failDumpFor && url.endsWith(fake.failDumpFor)) throw new Error('pg_dump failed'); },
    backupDir: join(dir, 'backups'),
    now: () => new Date('2026-11-08T00:00:00Z'),
    out: (l) => out.push(l),
    err: (l) => out.push(l),
  };
}

describe('memsmith projects --prune --yes', () => {
  it('drops the empty project, forgets its team key, and asks for a restart', async () => {
    const fake = fakeDb();
    const out: string[] = [];
    const forgotten: string[] = [];
    expect(await runProjectsCommand(['--prune', '--yes'], deps(fake, out, forgotten))).toBe(0);
    expect(fake.statements).toEqual([
      `DROP DATABASE IF EXISTS "${msp(EMPTY)}" WITH (FORCE)`,
      'DELETE FROM projects WHERE id = $1',
      'DELETE FROM teams WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM projects WHERE team_id = $1)',
    ]);
    expect(forgotten).toEqual(['t-empty']);
    expect(out).toContain('Run `memsmith restart` to release connections to dropped databases.');
  });

  it('keeps the database, the project, and the key when the backup fails', async () => {
    const fake = fakeDb(msp(EMPTY));
    const out: string[] = [];
    const forgotten: string[] = [];
    expect(await runProjectsCommand(['--prune', '--yes'], deps(fake, out, forgotten))).toBe(1);
    expect(fake.statements).toEqual([]);
    expect(forgotten).toEqual([]);
    expect(out.join('\n')).not.toContain('memsmith restart');
  });
});
