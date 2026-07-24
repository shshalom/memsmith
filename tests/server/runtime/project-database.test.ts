import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readProjectMarker, writeProjectDatabaseName } from '../../../src/services/identity/project-identity.js';
import { projectDatabaseName, resolveProjectDatabaseName, ensureDatabaseExists } from '../../../src/server/runtime/resolve-project-database.js';
import { EmbeddedPostgresManager } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ms-dbmarker-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedMarker(m: Record<string, unknown>) {
  mkdirSync(join(root, '.memsmith'), { recursive: true });
  writeFileSync(join(root, '.memsmith', 'project.json'), JSON.stringify({ teamId: 't', projectId: 'p', note: 'n', ...m }), 'utf-8');
}

describe('marker databaseName', () => {
  it('readProjectMarker preserves databaseName', () => {
    seedMarker({ databaseName: 'msp_p' });
    expect(readProjectMarker(root)?.databaseName).toBe('msp_p');
  });
  it('writeProjectDatabaseName merges into existing marker without dropping fields', () => {
    seedMarker({ runtime: 'local', serverUrl: 'http://x' });
    writeProjectDatabaseName(root, 'msp_p');
    const m = readProjectMarker(root)!;
    expect(m.databaseName).toBe('msp_p');
    expect(m.runtime).toBe('local');
    expect(m.serverUrl).toBe('http://x');
    expect(m.teamId).toBe('t');
    expect(m.projectId).toBe('p');
  });
  it('writeProjectDatabaseName throws when no marker exists', () => {
    expect(() => writeProjectDatabaseName(root, 'msp_p')).toThrow();
  });
});

describe('projectDatabaseName', () => {
  it('strips dashes and prefixes msp_', () => {
    expect(projectDatabaseName('a1eafc94-039f-4369-920f-b8ba6bd43b03')).toBe('msp_a1eafc94039f4369920fb8ba6bd43b03');
  });
});

describe('resolveProjectDatabaseName', () => {
  const base = { cwd: '/x', readMarker: () => ({ teamId: 't', projectId: 'a1eafc94-1', note: 'n' } as any), writeName: () => {}, probeHasProjectRows: async () => false };
  it('returns marker.databaseName when set (no stamp, no probe)', async () => {
    let probed = false;
    const name = await resolveProjectDatabaseName({ ...base, readMarker: () => ({ teamId:'t', projectId:'p', note:'n', databaseName:'msp_fixed' } as any), probeHasProjectRows: async () => { probed = true; return true; } });
    expect(name).toBe('msp_fixed');
    expect(probed).toBe(false);
  });
  it('adopts postgres (and stamps) when the project already has rows there', async () => {
    let stamped = '';
    const name = await resolveProjectDatabaseName({ ...base, writeName: (_c, n) => { stamped = n; }, probeHasProjectRows: async () => true });
    expect(name).toBe('postgres');
    expect(stamped).toBe('postgres');
  });
  it('mints msp_<id> (and stamps) for a new project', async () => {
    let stamped = '';
    const name = await resolveProjectDatabaseName({ ...base, readMarker: () => ({ teamId:'t', projectId:'a1eafc94-1', note:'n' } as any), writeName: (_c, n) => { stamped = n; }, probeHasProjectRows: async () => false });
    expect(name).toBe(projectDatabaseName('a1eafc94-1'));
    expect(stamped).toBe(name);
  });
});

describe('ensureDatabaseExists', () => {
  it('no-ops for postgres', async () => {
    const calls: string[] = [];
    await ensureDatabaseExists(async (t) => { calls.push(t); return { rows: [] }; }, 'postgres');
    expect(calls).toEqual([]);
  });
  it('creates when pg_database lacks the name', async () => {
    const calls: string[] = [];
    await ensureDatabaseExists(async (t) => { calls.push(t); return { rows: t.includes('pg_database') ? [] : [] }; }, 'msp_x');
    expect(calls.some(c => c.includes('pg_database'))).toBe(true);
    expect(calls.some(c => c.startsWith('CREATE DATABASE'))).toBe(true);
  });
  it('does NOT create when the db already exists', async () => {
    const calls: string[] = [];
    await ensureDatabaseExists(async (t) => { calls.push(t); return { rows: t.includes('pg_database') ? [{ one: 1 }] : [] }; }, 'msp_x');
    expect(calls.some(c => c.startsWith('CREATE DATABASE'))).toBe(false);
  });
});

describe('buildConnectionString', () => {
  it('targets the given database; defaults to postgres', () => {
    const mgr = new EmbeddedPostgresManager({ port: 55499 });
    expect(mgr.buildConnectionString()).toMatch(/\/postgres$/);
    expect(mgr.buildConnectionString('msp_x')).toMatch(/\/msp_x$/);
  });
});
