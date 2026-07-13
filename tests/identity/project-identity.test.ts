import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity, ensureBaseKey, MARKER_RELATIVE_PATH } from '../../src/services/identity/project-identity.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';

// Minimal fake pool: records SQL, returns empty rows (upserts are fire-and-check).
function fakePool() {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => { calls.push({ text, values }); return { rows: [], rowCount: 0 }; },
    connect: async () => ({ query: async (t: string, v?: unknown[]) => { calls.push({ text: t, values: v }); return { rows: [], rowCount: 0 }; }, release: () => {} }),
    end: async () => {},
  } as any;
}

describe('ensureProjectIdentity', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'memsmith-proj-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('mints identity + writes marker when absent', async () => {
    const pool = fakePool();
    const { teamId, projectId } = await ensureProjectIdentity(pool, cwd);
    expect(teamId).toMatch(/[0-9a-f-]{36}/);
    expect(projectId).toMatch(/[0-9a-f-]{36}/);
    const markerPath = join(cwd, MARKER_RELATIVE_PATH);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(marker.teamId).toBe(teamId);
    expect(marker.projectId).toBe(projectId);
    expect(JSON.stringify(marker)).not.toContain('key'); // marker carries NO secret key field
    // upserted teams + projects
    expect(pool.calls.some((c: any) => /insert into teams/i.test(c.text))).toBe(true);
    expect(pool.calls.some((c: any) => /insert into projects/i.test(c.text))).toBe(true);
  });

  it('recognizes existing marker without minting new ids', async () => {
    const pool1 = fakePool();
    const first = await ensureProjectIdentity(pool1, cwd);
    const pool2 = fakePool();
    const second = await ensureProjectIdentity(pool2, cwd);
    expect(second).toEqual(first); // same ids, recognized from marker
  });

  it('re-upserts PG rows from marker when marker present (clone case)', async () => {
    const pool1 = fakePool();
    await ensureProjectIdentity(pool1, cwd);
    const pool2 = fakePool();
    await ensureProjectIdentity(pool2, cwd);
    // even on recognition, teams/projects upserts are issued (idempotent) so a fresh DB gets the rows
    expect(pool2.calls.some((c: any) => /insert into teams/i.test(c.text))).toBe(true);
    expect(pool2.calls.some((c: any) => /insert into projects/i.test(c.text))).toBe(true);
  });
});

describe('ensureBaseKey', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'memsmith-key-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns cached key without minting when present', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-a', 'msk_existing');
    const pool = fakePool();
    const key = await ensureBaseKey(pool, 'team-a', 'proj-a', store);
    expect(key).toBe('msk_existing');
    // no api_keys insert when cached
    expect(pool.calls.some((c: any) => /insert into api_keys/i.test(c.text))).toBe(false);
  });

  it('mints + caches when absent (hash to PG, plaintext to store)', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    const pool = fakePool();
    const key = await ensureBaseKey(pool, 'team-b', 'proj-b', store);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(store.resolveKeyForTeam('team-b')).toBe(key);       // plaintext cached
    expect(pool.calls.some((c: any) => /insert into api_keys/i.test(c.text))).toBe(true); // hash persisted
  });
});
