import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity, ensureBaseKey, MARKER_RELATIVE_PATH } from '../../src/services/identity/project-identity.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';

// Minimal fake pool: records SQL, returns empty rows (upserts are fire-and-check).
// Pass `hashCheckRowCount` > 0 to make the hash-existence SELECT return a row.
function fakePool(hashCheckRowCount = 0) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      // Simulate a hash-existence check returning a row when configured.
      if (hashCheckRowCount > 0 && /FROM api_keys WHERE key_hash/i.test(text)) {
        return { rows: [{ '?column?': 1 }], rowCount: hashCheckRowCount };
      }
      return { rows: [], rowCount: 0 };
    },
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
    // projects INSERT must supply a non-empty name (NOT NULL column — regression guard)
    const projectsInsert = pool.calls.find((c: any) => /insert into projects/i.test(c.text));
    expect(projectsInsert).toBeDefined();
    expect(/insert into projects.*\bname\b/i.test(projectsInsert!.text)).toBe(true);
    const nameValue = projectsInsert!.values?.find((v: unknown) => typeof v === 'string' && v.length > 0 && v !== teamId);
    expect(nameValue).toBeDefined(); // a non-empty name value (projectId used as name) was passed
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

  it('returns cached key without minting when present and hash exists in DB', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-a', 'msk_existing');
    // Pool configured to return a row for the hash-existence SELECT.
    const pool = fakePool(1);
    const key = await ensureBaseKey(pool, 'team-a', 'proj-a', store);
    expect(key).toBe('msk_existing');
    // no api_keys INSERT when cached and hash verified in DB
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

  it('C1 scope assertion: minted key INSERT includes memories:read and memories:write', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    const pool = fakePool();
    await ensureBaseKey(pool, 'team-c', 'proj-c', store);
    const insertCall = pool.calls.find((c: any) => /insert into api_keys/i.test(c.text));
    expect(insertCall).toBeDefined();
    // The scopes arg is the 5th value ($5) — a JSON string.
    const scopesArg = insertCall!.values?.[4] as string;
    expect(typeof scopesArg).toBe('string');
    const scopes: string[] = JSON.parse(scopesArg);
    expect(scopes).toContain('memories:read');
    expect(scopes).toContain('memories:write');
  });

  it('I1 cache/DB-drift repair: cached key but hash absent → re-inserts hash, returns same key', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-d', 'msk_cached_key');
    // Pool configured to return 0 rows for hash-existence SELECT (simulates DB drift).
    const pool = fakePool(0);
    const key = await ensureBaseKey(pool, 'team-d', 'proj-d', store);
    // Must return the SAME cached key, not a new one.
    expect(key).toBe('msk_cached_key');
    // Must have re-inserted the hash into api_keys.
    expect(pool.calls.some((c: any) => /insert into api_keys/i.test(c.text))).toBe(true);
  });

  it('I1 cache hit, hash present: cached key + hash in DB → returns cached key with NO INSERT', async () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-e', 'msk_verified_key');
    // Pool configured to return 1 row for hash-existence SELECT.
    const pool = fakePool(1);
    const key = await ensureBaseKey(pool, 'team-e', 'proj-e', store);
    expect(key).toBe('msk_verified_key');
    // No INSERT should occur — hash already in DB.
    expect(pool.calls.some((c: any) => /insert into api_keys/i.test(c.text))).toBe(false);
  });
});
