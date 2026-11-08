import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity, readProjectMarker } from '../../../src/services/identity/project-identity.js';
import { ensureLocalTeamId, readLocalTeamId } from '../../../src/services/identity/local-team.js';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';
import { hashApiKey } from '../../../src/services/hooks/server-bootstrap.js';

// A folder with no marker used to get a brand-new project under a brand-new
// random team, cut off from every other project on the machine.

const REPO = join(import.meta.dir, '..', '..', '..');
const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

let base: string;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ms-local-team-')));
  dataDir = join(base, 'data');
  savedDataDir = process.env.MEMSMITH_DATA_DIR;
  process.env.MEMSMITH_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env.MEMSMITH_DATA_DIR = savedDataDir;
  rmSync(base, { recursive: true, force: true });
});

describe('the machine-wide local team', () => {
  it('owns new projects in two unrelated folders', async () => {
    mkdirSync(join(base, 'alpha'));
    mkdirSync(join(base, 'beta'));
    const alpha = await ensureProjectIdentity(fakePool as never, join(base, 'alpha'));
    const beta = await ensureProjectIdentity(fakePool as never, join(base, 'beta'));
    expect(alpha.projectId).not.toBe(beta.projectId);
    expect(alpha.teamId).toBe(beta.teamId);
    expect(alpha.teamId).toBe(readLocalTeamId()!);
  });

  it('leaves an existing marker in its own team', async () => {
    mkdirSync(join(base, 'old', '.memsmith'), { recursive: true });
    writeFileSync(join(base, 'old', '.memsmith', 'project.json'), JSON.stringify({ teamId: 't-old', projectId: 'p-old' }));
    const ids = await ensureProjectIdentity(fakePool as never, join(base, 'old'));
    expect(ids).toEqual({ teamId: 't-old', projectId: 'p-old' });
  });

  it('is the same team for every concurrent first creation', async () => {
    const worker = join(base, 'worker.ts');
    writeFileSync(worker, `
import { ensureProjectIdentity } from ${JSON.stringify(join(REPO, 'src/services/identity/project-identity.ts'))};
const pool = { async query() { return { rows: [], rowCount: 0 }; } };
console.log((await ensureProjectIdentity(pool, process.argv[2])).teamId);
`);
    const folders = Array.from({ length: 6 }, (_, i) => join(base, `p${i}`));
    for (const f of folders) mkdirSync(f);
    const teams = (await Promise.all(folders.map((folder) => new Promise<string>((resolve) => {
      const child = spawn('bun', [worker, folder], { env: { ...process.env, MEMSMITH_DATA_DIR: dataDir } });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('close', () => resolve(out.trim().split('\n').pop() ?? ''));
      child.on('error', () => resolve(''));
    })))).filter(Boolean);
    expect(teams.length).toBe(6);
    expect(new Set(teams).size).toBe(1);
    expect(teams[0]).toBe(readLocalTeamId()!);
    for (const f of folders) expect(readProjectMarker(f)?.teamId).toBe(teams[0]);
  }, 60_000);

  it('survives a corrupt team file by replacing it once', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'local-team.json'), '{ broken');
    const id = ensureLocalTeamId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ensureLocalTeamId()).toBe(id);
  });
});

describe('the created-project report', () => {
  it('is returned only by the call that created the project', async () => {
    const folder = join(base, 'fresh');
    mkdirSync(folder);
    const first = await ensureProjectIdentity(fakePool as never, folder);
    expect(first.created).toEqual({ root: folder, name: 'fresh' });
    const second = await ensureProjectIdentity(fakePool as never, folder);
    expect(second.created).toBeUndefined();
  });
});

describe('keys for projects in the local team', () => {
  // postgres-auth never lets a project-scoped key reach another project, so a
  // key shared by the team scoped every later project to the first one.
  function recordingPool() {
    const keyRows: Array<{ hash: string; teamId: string; projectId: string }> = [];
    return {
      keyRows,
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO api_keys')) {
          keyRows.push({ hash: String(params[1]), teamId: String(params[2]), projectId: String(params[3]) });
        }
        if (sql.startsWith('SELECT 1 FROM api_keys')) {
          const hit = keyRows.some((r) => r.hash === params[0] && r.teamId === params[1]);
          return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  it('gives each project its own key, anchored to that project', async () => {
    const pool = recordingPool();
    const store = new CredentialStore(join(base, 'credentials.json'));
    mkdirSync(join(base, 'alpha'));
    mkdirSync(join(base, 'beta'));
    const alpha = await ensureProjectIdentity(pool as never, join(base, 'alpha'), store);
    const beta = await ensureProjectIdentity(pool as never, join(base, 'beta'), store);
    const alphaKey = store.resolveKeyFor(alpha)!;
    const betaKey = store.resolveKeyFor(beta)!;
    expect(alphaKey).toBeTruthy();
    expect(betaKey).toBeTruthy();
    expect(alphaKey).not.toBe(betaKey);
    expect(pool.keyRows.find((r) => r.hash === hashApiKey(alphaKey))?.projectId).toBe(alpha.projectId);
    expect(pool.keyRows.find((r) => r.hash === hashApiKey(betaKey))?.projectId).toBe(beta.projectId);

    await ensureProjectIdentity(pool as never, join(base, 'alpha'), store);
    expect(store.resolveKeyFor(alpha)).toBe(alphaKey);
    expect(pool.keyRows.length).toBe(2);
  });

  it('switches a joined project to its new team key and leaves the rest alone', () => {
    const store = new CredentialStore(join(base, 'credentials.json'));
    store.storeProjectKeyIfAbsent('t-local', 'p-a', 'key-a');
    store.storeProjectKeyIfAbsent('t-local', 'p-b', 'key-b');
    store.storeKeyForTeam('t-joined', 'key-team');
    expect(store.resolveKeyFor({ teamId: 't-joined', projectId: 'p-a' })).toBe('key-team');
    expect(store.resolveKeyFor({ teamId: 't-local', projectId: 'p-b' })).toBe('key-b');
    expect(store.listTeamIdsWithKeys().sort()).toEqual(['t-joined', 't-local']);
    expect(store.listKeys().sort()).toEqual(['key-a', 'key-b', 'key-team']);
  });
});
