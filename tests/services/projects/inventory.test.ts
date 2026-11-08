import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadInventory,
  type InventorySource,
  type ProjectRow,
  type RecordStats,
} from '../../../src/services/projects/inventory.js';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';
const D = '44444444-4444-4444-4444-444444444444';
const msp = (id: string) => `msp_${id.replace(/-/g, '')}`;

function marker(dir: string, projectId: string, extra: object = {}) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n', ...extra }));
}

const stats = (o: Partial<RecordStats> = {}): RecordStats => ({
  observations: 0, notes: 0, events: 0, sessions: 0, lastActivity: null, ...o,
});

function source(rows: ProjectRow[], databases: string[], byDb: Record<string, RecordStats>, accountDatabase = 'postgres'): InventorySource {
  return {
    accountDatabase,
    listProjects: async () => rows,
    listDatabases: async () => databases,
    recordStats: async (db, projectId) => {
      const key = projectId ? `${db}:${projectId}` : db;
      return byDb[key] ?? byDb[db] ?? stats();
    },
  };
}

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'ms-inv-'))); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('loadInventory', () => {
  it('flags empty, missing-db, orphan-db, stray, and archived projects', async () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    marker(repo, A);
    mkdirSync(join(repo, 'src', 'cli'), { recursive: true });
    marker(join(repo, 'src', 'cli'), B);

    const rows: ProjectRow[] = [
      { id: A, teamId: `t-${A}`, name: 'repo', metadata: { memsmith_project_path: repo } },
      { id: B, teamId: `t-${B}`, name: 'cli', metadata: { memsmith_project_path: join(repo, 'src', 'cli') } },
      { id: C, teamId: `t-${C}`, name: 'never-written', metadata: {} },
      { id: D, teamId: `t-${D}`, name: 'old', metadata: { mergedInto: A, archivedAt: '2026-11-01T00:00:00.000Z' } },
    ];
    const orphan = 'msp_99999999999999999999999999999999';
    const inv = await loadInventory(
      source(rows, ['postgres', msp(A), msp(B), msp(D), orphan], {
        [`${msp(A)}:${A}`]: stats({ observations: 5, notes: 1, events: 9, sessions: 2, lastActivity: '2026-11-07T10:00:00.000Z' }),
        [`${msp(B)}:${B}`]: stats({ events: 3 }),
        [`${msp(D)}:${D}`]: stats({ observations: 2 }),
        [orphan]: stats(),
      }),
      { hasKeyForTeam: () => true },
    );

    const byId = new Map(inv.projects.map((p) => [p.projectId, p]));
    expect(byId.get(A)).toMatchObject({
      name: 'repo', runtime: 'local', team: 'local', databaseName: msp(A), folders: [repo], flags: [],
      counts: { observations: 5, notes: 1, events: 9, sessions: 2 }, lastActivity: '2026-11-07T10:00:00.000Z',
    });
    expect(byId.get(B)?.flags).toEqual(['stray']);
    expect(byId.get(B)?.folders).toEqual([join(repo, 'src', 'cli')]);
    expect(byId.get(B)?.strayUnder).toEqual([{ root: repo, projectId: A }]);
    expect(byId.get(C)?.flags).toEqual(['missing-db']);
    expect(byId.get(C)?.counts).toMatchObject({ observations: 0, events: 0 });
    expect(byId.get(C)?.databaseName).toBeNull();
    expect(byId.get(D)?.flags).toEqual(['archived']);
    expect(byId.get(D)?.mergedInto).toBe(A);

    const orphanEntry = inv.projects.find((p) => p.projectId === null);
    expect(orphanEntry).toMatchObject({ databaseName: orphan, flags: ['orphan-db', 'empty'] });
    expect(inv.strays.map((s) => s.dir)).toEqual([join(repo, 'src', 'cli')]);
  });

  it('marks a project with no records as empty', async () => {
    const inv = await loadInventory(source([{ id: A, teamId: 't', name: 'a', metadata: {} }], [msp(A)], {}), {});
    expect(inv.projects[0].flags).toEqual(['empty']);
  });

  it('does not call a database an orphan when a marker stamps it for a project', async () => {
    const dir = join(home, 'stamped');
    mkdirSync(dir);
    const stampedDb = 'msp_99999999999999999999999999999999';
    marker(dir, A, { databaseName: stampedDb });
    const inv = await loadInventory(
      source([{ id: A, teamId: `t-${A}`, name: 'stamped', metadata: { memsmith_project_path: dir } }], [stampedDb], { [`${stampedDb}:${A}`]: stats({ events: 2 }) }),
      {},
    );
    expect(inv.projects.map((p) => [p.projectId, p.databaseName])).toEqual([[A, stampedDb]]);
  });

  it('leaves unreadable counts unknown instead of empty', async () => {
    const unreadable: InventorySource = { ...source([{ id: A, teamId: 't', name: 'a', metadata: {} }], [msp(A), msp(B)], {}), recordStats: async () => null };
    const inv = await loadInventory(unreadable, {});
    expect(inv.projects.find((p) => p.projectId === A)).toMatchObject({ counts: null, flags: [] });
    expect(inv.projects.find((p) => p.databaseName === msp(B))?.flags).toEqual(['orphan-db']);
  });

  it('finds a marker under a search root that names a project', async () => {
    const ws = join(home, 'ws');
    mkdirSync(join(ws, 'app', '.git'), { recursive: true });
    marker(join(ws, 'app'), A);
    const inv = await loadInventory(source([{ id: A, teamId: 't', name: 'a', metadata: {} }], [msp(A)], {}), { scanRoots: [ws] });
    expect(inv.projects[0].folders).toEqual([join(ws, 'app')]);
  });

  it('never calls the account database an orphan', async () => {
    const account = 'msp_99999999999999999999999999999999';
    const inv = await loadInventory(source([], ['postgres', account], {}, account), {});
    expect(inv.projects).toEqual([]);
  });

  it('reads a legacy project from the database its marker names', async () => {
    const dir = join(home, 'dogfood');
    mkdirSync(dir);
    marker(dir, A, { databaseName: 'postgres' });
    const inv = await loadInventory(
      source([{ id: A, teamId: `t-${A}`, name: 'dogfood', metadata: { memsmith_project_path: dir } }], ['postgres'], {
        [`postgres:${A}`]: stats({ observations: 40 }),
      }),
      {},
    );
    expect(inv.projects[0]).toMatchObject({ databaseName: 'postgres', flags: [], counts: { observations: 40 } });
  });

  it('reports a joined team project and its server', async () => {
    const dir = join(home, 'shared');
    mkdirSync(dir);
    marker(dir, A, { runtime: 'server', serverUrl: 'https://memsmith.example.com' });
    const rows = [{ id: A, teamId: `t-${A}`, name: 'shared', metadata: { memsmith_project_path: dir } }];
    const joined = await loadInventory(source(rows, [msp(A)], { [msp(A)]: stats({ events: 1 }) }), { hasKeyForTeam: () => true });
    expect(joined.projects[0]).toMatchObject({ runtime: 'team', team: 'joined team at https://memsmith.example.com' });
    const notJoined = await loadInventory(source(rows, [msp(A)], { [msp(A)]: stats({ events: 1 }) }), { hasKeyForTeam: () => false });
    expect(notJoined.projects[0].team).toBe('team at https://memsmith.example.com, not joined on this machine');
  });

  it('does not list a recorded folder whose marker now names another project', async () => {
    const dir = join(home, 'moved');
    mkdirSync(dir);
    marker(dir, B);
    const inv = await loadInventory(
      source([{ id: A, teamId: 't', name: 'moved', metadata: { memsmith_project_path: dir } }], [msp(A)], { [msp(A)]: stats({ events: 1 }) }),
      {},
    );
    expect(inv.projects[0].folders).toEqual([]);
  });
});
