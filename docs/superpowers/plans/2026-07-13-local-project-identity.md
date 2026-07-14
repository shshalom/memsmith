# Local Project Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project a durable memory identity (team_id + project_id + a real base key) born at session-init, so local mode holds a real API key (fixing local read-back / GAP-A) and every project is ready to be promoted to team mode without a re-key.

**Architecture:** Additive. A new `identity/` module births per-project identity (uuids + PG rows + committed non-secret marker) and mints a base key by reusing the existing better-auth key primitives (`createRawApiKey`/`hashApiKey`/`PostgresAuthRepository.createApiKey`). A `CredentialStore` caches the plaintext key in `~/.memsmith/credentials.json` (0600) behind a `resolveKeyForTeam` seam (AWS later). `buildServerContext` resolves the key from that seam instead of demanding `MEMSMITH_SERVER_API_KEY`. The session-init hook is the trigger. A read-only Settings panel shows the minted identity. A one-time seed migrates this dogfood project's data.

**Tech Stack:** TypeScript, Bun (test + build), embedded Postgres (pgvector), better-auth apiKey plugin, React (viewer Settings UI).

**Spec:** `docs/superpowers/specs/2026-07-13-local-project-identity-design.md`

## Global Constraints

- **The base key is a SECRET.** Its plaintext lives ONLY in `~/.memsmith/credentials.json` (chmod 0600) and the `Authorization` header; its hash lives in PG `api_keys`. It must NEVER be written to the repo or any committed file. `.memsmith/project.json` (committed) carries only non-secret ids.
- **Key is scoped to `team_id`**, not `(team_id, project_id)` — one key spans a team's projects.
- **Reuse existing key machinery**, do not reinvent: `createRawApiKey()`, `hashApiKey()`, `PostgresAuthRepository.createApiKey()`, `HOOK_API_KEY_SCOPES`, `LOCAL_HOOK_ACTOR_ID` from `src/services/hooks/server-bootstrap.ts` and `src/storage/postgres/auth.ts`.
- **Key retrieval behind `resolveKeyForTeam(teamId)`** so an AWS Secrets Manager impl can replace the file backing later without touching `buildServerContext`.
- **Never rename keep-list deps** (`claude-code`, `claude-agent`, `@anthropic-ai/*`).
- **The server-side keyless bypass (`postgres-auth.ts:87-108`) STAYS** as a graceful fallback; it is no longer the path local relies on.
- **Access-by-membership is NOT built here** (subsystem #3). Today key-possession = access; this is the honest current state.
- **Bun clean-env:** `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun ...`
- **Embedded psql** (for the seed): `~/.memsmith/pg-binaries/bin/psql` with `DYLD_LIBRARY_PATH=~/.memsmith/pg-binaries/lib`; conn `postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres`. claude-mem: `/usr/bin/sqlite3 ~/.claude-mem/claude-mem.db`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `embedded-pg-local-runtime`. Do not push. Do NOT `git checkout <hash>` (detaches HEAD) — stay on the branch.

---

### Task 1: CredentialStore (the key-retrieval seam)

**Files:**
- Create: `src/services/identity/credential-store.ts`
- Test: `tests/identity/credential-store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveKeyForTeam(teamId: string): string | null`, `storeKeyForTeam(teamId: string, key: string): void`. File `~/.memsmith/credentials.json` shape `{ keys: { [teamId]: plaintext } }`, mode 0600.

- [ ] **Step 1: Write the failing test**

Create `tests/identity/credential-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../src/services/identity/credential-store.js';

describe('CredentialStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'memsmith-cred-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('store then resolve round-trips a key', () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    expect(store.resolveKeyForTeam('team-a')).toBeNull();
    store.storeKeyForTeam('team-a', 'msk_secret_a');
    expect(store.resolveKeyForTeam('team-a')).toBe('msk_secret_a');
  });

  it('writes the file with 0600 permissions', () => {
    const path = join(dir, 'credentials.json');
    const store = new CredentialStore(path);
    store.storeKeyForTeam('team-a', 'msk_secret_a');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps multiple teams independent', () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-a', 'msk_a');
    store.storeKeyForTeam('team-b', 'msk_b');
    expect(store.resolveKeyForTeam('team-a')).toBe('msk_a');
    expect(store.resolveKeyForTeam('team-b')).toBe('msk_b');
  });

  it('resolve returns null for unknown team and when file absent', () => {
    const store = new CredentialStore(join(dir, 'nope.json'));
    expect(store.resolveKeyForTeam('team-x')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/credential-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CredentialStore**

Create `src/services/identity/credential-store.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

interface CredentialFile { keys: Record<string, string>; }

/**
 * Stores the PLAINTEXT base key per team, so buildServerContext can send it.
 * The secret lives ONLY here (0600) and in the Authorization header — never in
 * a repo. This is the local implementation of the key-retrieval seam; an AWS
 * Secrets Manager backing can later implement the same resolveKeyForTeam shape.
 */
export class CredentialStore {
  private readonly path: string;

  constructor(path: string = join(homedir(), '.memsmith', 'credentials.json')) {
    this.path = path;
  }

  resolveKeyForTeam(teamId: string): string | null {
    const file = this.read();
    return file.keys[teamId] ?? null;
  }

  storeKeyForTeam(teamId: string, key: string): void {
    const file = this.read();
    file.keys[teamId] = key;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // Enforce 0600 even if the file pre-existed with looser perms.
    chmodSync(this.path, 0o600);
  }

  private read(): CredentialFile {
    if (!existsSync(this.path)) return { keys: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CredentialFile>;
      return { keys: parsed.keys ?? {} };
    } catch {
      return { keys: {} };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/credential-store.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/services/identity/credential-store.ts tests/identity/credential-store.test.ts
git commit -m "$(printf 'feat(identity): CredentialStore — plaintext key cache (0600) behind resolveKeyForTeam seam\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: ProjectIdentity + ensureBaseKey (birth of identity)

**Files:**
- Create: `src/services/identity/project-identity.ts`
- Test: `tests/identity/project-identity.test.ts`

**Interfaces:**
- Consumes: `CredentialStore` (Task 1); `createRawApiKey`, `hashApiKey`, `HOOK_API_KEY_SCOPES`, `LOCAL_HOOK_ACTOR_ID` from `src/services/hooks/server-bootstrap.js`; `PostgresAuthRepository` from `src/storage/postgres/auth.js`; a `PostgresPool`.
- Produces:
  - `ensureProjectIdentity(pool, cwd): Promise<{ teamId: string; projectId: string }>` — reads/writes `<cwd>/.memsmith/project.json`, upserts PG `teams`/`projects` rows. Idempotent.
  - `ensureBaseKey(pool, teamId, projectId, store?): Promise<string>` — returns cached key or mints one (hash→PG, plaintext→store).
  - `MARKER_RELATIVE_PATH = '.memsmith/project.json'`.

- [ ] **Step 1: Write the failing test**

Create `tests/identity/project-identity.test.ts`. Uses a fake pool (records queries) + temp dirs; no live PG needed.

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/project-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement project-identity.ts**

Create `src/services/identity/project-identity.ts`:

```typescript
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { CredentialStore } from './credential-store.js';
import { createRawApiKey, hashApiKey, HOOK_API_KEY_SCOPES, LOCAL_HOOK_ACTOR_ID } from '../hooks/server-bootstrap.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import { logger } from '../../shared/logger.js';

export const MARKER_RELATIVE_PATH = '.memsmith/project.json';

interface ProjectMarker { projectId: string; teamId: string; note: string; }

const MARKER_NOTE =
  'Non-secret MemSmith identity pointer. The access key lives in ~/.memsmith, never here.';

// Minimal shape of the pg pool we use. The real pool satisfies this.
interface QueryablePool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>; }

function readMarker(cwd: string): ProjectMarker | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectMarker>;
    if (m.teamId && m.projectId) return { teamId: m.teamId, projectId: m.projectId, note: m.note ?? MARKER_NOTE };
    return null;
  } catch {
    return null;
  }
}

function writeMarker(cwd: string, marker: ProjectMarker): void {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(marker, null, 2), 'utf-8');
}

async function upsertTeamAndProject(pool: QueryablePool, teamId: string, projectId: string): Promise<void> {
  await pool.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [teamId]);
  await pool.query('INSERT INTO projects (id, team_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [projectId, teamId]);
}

/**
 * Resolve the current project's durable identity. Recognizes an existing
 * committed marker; otherwise mints uuids + a marker. Always (idempotently)
 * upserts the PG teams/projects rows so a fresh DB / cloned repo self-heals.
 */
export async function ensureProjectIdentity(
  pool: QueryablePool,
  cwd: string,
): Promise<{ teamId: string; projectId: string }> {
  const existing = readMarker(cwd);
  const teamId = existing?.teamId ?? randomUUID();
  const projectId = existing?.projectId ?? randomUUID();
  if (!existing) {
    writeMarker(cwd, { teamId, projectId, note: MARKER_NOTE });
    logger.info('IDENTITY', 'minted project identity', { teamId, projectId, cwd });
  }
  await upsertTeamAndProject(pool, teamId, projectId);
  return { teamId, projectId };
}

/**
 * Return the team's base key: the cached plaintext if present, else mint a new
 * key (hash persisted to api_keys, plaintext cached in the store). Reuses the
 * existing better-auth key primitives.
 */
export async function ensureBaseKey(
  pool: QueryablePool,
  teamId: string,
  projectId: string,
  store: CredentialStore = new CredentialStore(),
): Promise<string> {
  const cached = store.resolveKeyForTeam(teamId);
  if (cached) return cached;

  const rawKey = createRawApiKey();
  const keyHash = hashApiKey(rawKey);
  const repo = new PostgresAuthRepository(pool as any);
  await repo.createApiKey({
    keyHash,
    teamId,
    projectId,
    actorId: LOCAL_HOOK_ACTOR_ID,
    scopes: [...HOOK_API_KEY_SCOPES],
  });
  store.storeKeyForTeam(teamId, rawKey);
  logger.info('IDENTITY', 'minted base key', { teamId, projectId });
  return rawKey;
}
```

Notes for the implementer: confirm the exact import paths/exports of `createRawApiKey`, `hashApiKey`, `HOOK_API_KEY_SCOPES`, `LOCAL_HOOK_ACTOR_ID` in `src/services/hooks/server-bootstrap.ts` and `PostgresAuthRepository.createApiKey` in `src/storage/postgres/auth.ts` — they are all present (verified). If `createApiKey` returns a value you don't need, ignore it. If `logger` import path differs, match the project's logger import used elsewhere in `src/services/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/project-identity.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/identity/project-identity.ts tests/identity/project-identity.test.ts
git commit -m "$(printf 'feat(identity): ensureProjectIdentity + ensureBaseKey — per-project durable identity birth\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Wire identity into buildServerContext + session-init

**Files:**
- Modify: `src/services/hooks/runtime-selector.ts` (`buildServerContext` ~56-102)
- Modify: the session-init hook handler (find it: `grep -rln "session-init\|sessionInit\|hook claude-code session-init" src/services/hooks src/servers src/cli --include="*.ts"`; it's the handler behind `server-service.cjs hook claude-code session-init`)
- Test: `tests/hooks/local-identity-context.test.ts`

**Interfaces:**
- Consumes: `ensureProjectIdentity`, `ensureBaseKey` (Task 2); `CredentialStore.resolveKeyForTeam` (Task 1); existing `ServerRuntimeContext { runtime, client, projectId, serverBaseUrl }`.
- Produces: `buildServerContext` that, in local mode, resolves the key via `resolveKeyForTeam(teamId-for-cwd)` and the projectId from the marker, instead of bailing on empty `MEMSMITH_SERVER_API_KEY`.

- [ ] **Step 1: Write the failing test**

Create `tests/hooks/local-identity-context.test.ts`. It exercises the key-resolution branch of `buildServerContext` with a marker + credentials present, asserting a context is built (not null).

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { buildServerContext } from '../../src/services/hooks/runtime-selector.js';

// Assumes buildServerContext accepts an options bag { cwd, credentialStore } for
// testability (the real hook passes the session cwd + default store). If the
// implementer instead reads process.env.MEMSMITH_PROJECT_CWD, set that here.
describe('buildServerContext in local mode with a project key', () => {
  let cwd: string; let credPath: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'memsmith-ctx-'));
    mkdirSync(join(cwd, '.memsmith'), { recursive: true });
    writeFileSync(join(cwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'team-ctx', projectId: 'proj-ctx', note: 'x' }), 'utf-8');
    credPath = join(cwd, 'credentials.json');
    new CredentialStore(credPath).storeKeyForTeam('team-ctx', 'msk_ctx');
    process.env.MEMSMITH_SERVER_URL = 'http://127.0.0.1:38879';
    process.env.MEMSMITH_SERVER_API_KEY = ''; // empty — the whole point
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); delete process.env.MEMSMITH_SERVER_URL; });

  it('builds a context from the resolved project key (no longer returns null)', () => {
    const ctx = buildServerContext({ cwd, credentialStore: new CredentialStore(credPath) });
    expect(ctx).not.toBeNull();
    expect(ctx!.projectId).toBe('proj-ctx');
    expect(ctx!.runtime).toBe('server'); // local uses the server client shape
  });

  it('returns null (falls back) when no key and no marker', () => {
    const empty = mkdtempSync(join(tmpdir(), 'memsmith-empty-'));
    const ctx = buildServerContext({ cwd: empty, credentialStore: new CredentialStore(join(empty, 'c.json')) });
    expect(ctx).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/hooks/local-identity-context.test.ts`
Expected: FAIL — `buildServerContext` doesn't accept options / returns null without an env key.

- [ ] **Step 3: Modify buildServerContext**

In `src/services/hooks/runtime-selector.ts`, extend `buildServerContext` to accept an optional `{ cwd?, credentialStore? }` bag. Precedence: an explicit `MEMSMITH_SERVER_API_KEY` (team mode) still wins; when it's empty, resolve from the marker + CredentialStore:

```typescript
import { CredentialStore } from '../identity/credential-store.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface BuildServerContextOptions { cwd?: string; credentialStore?: CredentialStore; }

function readMarkerFor(cwd: string): { teamId: string; projectId: string } | null {
  const p = join(cwd, '.memsmith', 'project.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as { teamId?: string; projectId?: string };
    return m.teamId && m.projectId ? { teamId: m.teamId, projectId: m.projectId } : null;
  } catch { return null; }
}

export function buildServerContext(options: BuildServerContextOptions = {}): ServerRuntimeContext | null {
  const settings = loadFromFileOnce();
  // ... existing serverBaseUrl resolution unchanged ...
  const serverBaseUrl = pickFirstNonEmpty(settings.MEMSMITH_SERVER_URL, settings.MEMSMITH_SERVER_BETA_URL);
  if (!serverBaseUrl) { logger.warn('HOOK', '[server-fallback] reason=missing_base_url'); return null; }

  let apiKey = pickFirstNonEmpty(settings.MEMSMITH_SERVER_API_KEY, settings.MEMSMITH_SERVER_BETA_API_KEY);
  let projectId = pickFirstNonEmpty(settings.MEMSMITH_SERVER_PROJECT_ID, settings.MEMSMITH_SERVER_BETA_PROJECT_ID);

  // Local-identity path: when no explicit team-mode key is configured, resolve
  // the project's base key from the marker + CredentialStore (the key-everywhere
  // seam). This is what makes local injection + MCP recall work without the
  // keyless bypass.
  if (!apiKey) {
    const cwd = options.cwd ?? process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
    const marker = readMarkerFor(cwd);
    if (marker) {
      const store = options.credentialStore ?? new CredentialStore();
      const resolved = store.resolveKeyForTeam(marker.teamId);
      if (resolved) { apiKey = resolved; projectId = projectId || marker.projectId; }
    }
  }

  if (!apiKey) { logger.warn('HOOK', '[server-fallback] reason=missing_api_key'); return null; }
  if (!projectId) { logger.warn('HOOK', '[server-fallback] reason=missing_project_id'); return null; }

  return { runtime: 'server', client: new ServerClient({ serverBaseUrl, apiKey }), projectId, serverBaseUrl };
}
```

Keep the existing `pickFirstNonEmpty` helper and `ServerClient`/`ServerRuntimeContext` usage exactly as they are; only add the `!apiKey` resolution block and the options param. The server-side keyless bypass remains untouched as the fallback when this still returns null.

- [ ] **Step 4: Wire session-init to mint identity**

In the session-init hook handler (located via the grep above), after the local runtime/pool is available, call (guarded, non-fatal):

```typescript
try {
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  const { ensureProjectIdentity, ensureBaseKey } = await import('../identity/project-identity.js');
  const { teamId, projectId } = await ensureProjectIdentity(pool, cwd);
  await ensureBaseKey(pool, teamId, projectId);
} catch (err) {
  logger.warn('IDENTITY', 'session-init identity mint skipped (non-fatal)', {}, err instanceof Error ? err : new Error(String(err)));
}
```

Use whatever pool/runtime handle the session-init handler already has. If session-init has no pool (runtime not up), the guard logs and skips — next session-init retries (mirrors the first-run-import non-fatal pattern). Match the handler's existing import + logger conventions.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/hooks/local-identity-context.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck the touched files**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add src/services/hooks/runtime-selector.ts tests/hooks/local-identity-context.test.ts src/services/**/**session-init**  # adjust to the actual session-init file
git commit -m "$(printf 'feat(identity): resolve project key in buildServerContext + mint identity at session-init\n\nCloses GAP-A the key-everywhere way: local mode now sends a real per-project\nkey (from the CredentialStore seam) instead of relying on the keyless bypass.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Read-only Settings identity surface

**Files:**
- Modify: settings data source — `src/ui/viewer/utils/settingsData.ts` (add an identity fetch) and its server route (`src/server/routes/v1/settingsRoutes.ts`, or wherever the settings data is served)
- Modify: `src/ui/viewer/views/SettingsView.tsx` (add a read-only identity card)
- Test: `tests/identity/settings-identity-endpoint.test.ts`

**Interfaces:**
- Consumes: the running project's `{teamId, projectId}` (from marker) + `CredentialStore.resolveKeyForTeam`.
- Produces: an endpoint returning `{ teamId, projectId, keyPresent: boolean, keyMasked: string }` and, only on explicit reveal, `keyPlaintext`. A Settings card rendering them.

- [ ] **Step 1: Write the failing test**

Create `tests/identity/settings-identity-endpoint.test.ts` — test the pure mask helper + the data-assembly function (not the full HTTP server):

```typescript
import { describe, it, expect } from 'bun:test';
import { maskKey, buildIdentityPayload } from '../../src/server/routes/v1/identity-payload.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('identity payload', () => {
  it('maskKey shows only the last 4 chars', () => {
    expect(maskKey('msk_abcdefgh1234')).toBe('msk_••••••••1234');
    expect(maskKey('')).toBe('');
  });

  it('buildIdentityPayload reports keyPresent + masked, never plaintext unless revealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-idp-'));
    const store = new CredentialStore(join(dir, 'c.json'));
    store.storeKeyForTeam('team-z', 'msk_secretzz1234');
    const payload = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: false });
    expect(payload.teamId).toBe('team-z');
    expect(payload.projectId).toBe('proj-z');
    expect(payload.keyPresent).toBe(true);
    expect(payload.keyMasked).toBe('msk_••••••••1234');
    expect((payload as any).keyPlaintext).toBeUndefined();
    const revealed = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: true });
    expect(revealed.keyPlaintext).toBe('msk_secretzz1234');
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/settings-identity-endpoint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the identity payload helper**

Create `src/server/routes/v1/identity-payload.ts`:

```typescript
import { CredentialStore } from '../../../services/identity/credential-store.js';

export function maskKey(key: string): string {
  if (!key) return '';
  const last4 = key.slice(-4);
  const prefix = key.includes('_') ? key.slice(0, key.indexOf('_') + 1) : '';
  return `${prefix}${'•'.repeat(8)}${last4}`;
}

export interface IdentityPayload {
  teamId: string;
  projectId: string;
  keyPresent: boolean;
  keyMasked: string;
  keyPlaintext?: string;
}

export function buildIdentityPayload(
  ids: { teamId: string; projectId: string },
  store: CredentialStore,
  opts: { reveal: boolean },
): IdentityPayload {
  const key = store.resolveKeyForTeam(ids.teamId);
  const payload: IdentityPayload = {
    teamId: ids.teamId,
    projectId: ids.projectId,
    keyPresent: Boolean(key),
    keyMasked: key ? maskKey(key) : '',
  };
  if (opts.reveal && key) payload.keyPlaintext = key;
  return payload;
}
```

- [ ] **Step 4: Wire the endpoint + Settings card**

Add a route that serves `buildIdentityPayload(...)` for the running project (read `{teamId, projectId}` from the marker at `MEMSMITH_PROJECT_CWD`; `reveal` from a query param, only honored on loopback like the rest of the local dashboard). Follow the existing `settingsRoutes.ts` registration pattern.

In `src/ui/viewer/utils/settingsData.ts` add a `fetchIdentity()` that GETs the endpoint. In `src/ui/viewer/views/SettingsView.tsx` add a read-only card (match the existing card styling — do NOT restyle) showing `teamId`, `projectId`, and `keyMasked` with a "Reveal" toggle that refetches with `reveal=true` and shows `keyPlaintext`. No edit/rotate controls.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/identity/settings-identity-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/v1/identity-payload.ts tests/identity/settings-identity-endpoint.test.ts src/ui/viewer/utils/settingsData.ts src/ui/viewer/views/SettingsView.tsx src/server/routes/v1/settingsRoutes.ts
git commit -m "$(printf 'feat(identity): read-only Settings identity surface (team/project id + masked key)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: One-time dogfood seed (re-scope 2790 + import claude-mem delta)

**Files:**
- Create: `scripts/seed-dogfood-identity.ts` (one-off, run manually; NOT part of plugin runtime)
- No test file (it's a one-shot migration run against live data with a backup); it self-verifies with row counts and aborts loudly on mismatch.

**Interfaces:**
- Consumes: `ensureProjectIdentity`/`ensureBaseKey` (Task 2), the embedded PG, the claude-mem SQLite.
- Produces: this project's `.memsmith/project.json`, its key in `credentials.json`, re-scoped + delta-imported observations.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-dogfood-identity.ts`:

```typescript
/**
 * ONE-TIME dogfood seed. Mints this project's durable identity, re-scopes the
 * existing 'local'/'local' observations to it, and imports the claude-mem
 * team-agent-memory delta (dedup by content_hash). Idempotent-ish: re-running
 * recognizes the existing marker and only re-imports missing content hashes.
 *
 * Run: env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin \
 *   MEMSMITH_PROJECT_CWD=/Users/shwaits/Workspace/team-agent-memory \
 *   ~/.bun/bin/bun scripts/seed-dogfood-identity.ts
 */
import { Client } from 'pg';
import { Database } from 'bun:sqlite';
import { ensureProjectIdentity, ensureBaseKey } from '../src/services/identity/project-identity.js';

const PG = 'postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres';
const CLAUDE_MEM_DB = `${process.env.HOME}/.claude-mem/claude-mem.db`;
const CWD = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();

async function main() {
  const pg = new Client({ connectionString: PG });
  await pg.connect();
  const pool = { query: (t: string, v?: unknown[]) => pg.query(t, v as any) } as any;

  // 1. Mint / recognize identity for this project.
  const { teamId, projectId } = await ensureProjectIdentity(pool, CWD);
  await ensureBaseKey(pool, teamId, projectId);
  console.log(`[seed] identity: team=${teamId} project=${projectId}`);

  // 2. Re-scope existing local/local rows (idempotent: only rows still on 'local').
  const before = await pg.query("SELECT count(*)::int n FROM observations WHERE team_id='local' AND project_id='local'");
  const legacyCount = before.rows[0].n as number;
  if (legacyCount > 0) {
    await pg.query('UPDATE observations SET team_id=$1, project_id=$2 WHERE team_id=$3 AND project_id=$4',
      [teamId, projectId, 'local', 'local']);
    console.log(`[seed] re-scoped ${legacyCount} observations local/local -> ${teamId}/${projectId}`);
  } else {
    console.log('[seed] no local/local rows to re-scope (already done)');
  }

  // 3. Import claude-mem delta, dedup by content_hash.
  const cm = new Database(CLAUDE_MEM_DB, { readonly: true });
  const rows = cm.query(
    "SELECT content_hash, text, type, title, narrative, created_at FROM observations WHERE project='team-agent-memory' AND content_hash IS NOT NULL"
  ).all() as Array<{ content_hash: string; text: string; type: string; title: string; narrative: string; created_at: string }>;
  const existing = await pg.query('SELECT content_hash FROM observations WHERE team_id=$1 AND content_hash IS NOT NULL', [teamId]);
  const have = new Set(existing.rows.map((r: any) => r.content_hash));
  let imported = 0;
  for (const r of rows) {
    if (have.has(r.content_hash)) continue;
    await pg.query(
      `INSERT INTO observations (id, team_id, project_id, obs_type, lifecycle_state, content, content_hash, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [teamId, projectId, r.type, r.type === 'decision' ? 'active' : 'resolved',
       r.narrative || r.text || r.title || '', r.content_hash, r.created_at]);
    imported++;
  }
  cm.close();
  console.log(`[seed] imported ${imported} new observations from claude-mem (of ${rows.length} candidates)`);

  // 4. Verify: no local/local rows remain; report final scope count.
  const after = await pg.query("SELECT count(*)::int n FROM observations WHERE team_id='local' AND project_id='local'");
  if ((after.rows[0].n as number) !== 0) throw new Error(`[seed] ABORT: ${after.rows[0].n} local/local rows still present after re-scope`);
  const total = await pg.query('SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2', [teamId, projectId]);
  console.log(`[seed] DONE. dogfood scope now holds ${total.rows[0].n} observations.`);
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Implementer notes: confirm the `observations` column names against the live schema before running (`\d observations` via the embedded psql — the plan cites `obs_type`, `lifecycle_state`, `content`, `content_hash`, `created_at`; adjust the INSERT/SELECT to the ACTUAL columns; do NOT invent columns). Confirm the claude-mem `observations` columns exist (`content_hash`, `text`, `type`, `title`, `narrative`, `created_at` — verified present in the schema dump). If `gen_random_uuid()` isn't available, use the same id-generation the existing import path uses.

- [ ] **Step 2: Back up the PG data dir, then dry-inspect**

```bash
cp -R ~/.memsmith/pgdata ~/.memsmith/pgdata.pre-seed.bak
# confirm live columns before running:
env -i HOME="$HOME" PATH=/usr/bin:/bin DYLD_LIBRARY_PATH="$HOME/.memsmith/pg-binaries/lib" PGPASSWORD='memsmith-local' \
  ~/.memsmith/pg-binaries/bin/psql "postgresql://memsmith@127.0.0.1:55433/postgres" -c "\d observations"
```
Expected: a backup exists; the column list is printed. Adjust the script's SQL to match if needed.

- [ ] **Step 3: Run the seed**

Run:
```bash
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin \
  MEMSMITH_PROJECT_CWD=/Users/shwaits/Workspace/team-agent-memory \
  ~/.bun/bin/bun scripts/seed-dogfood-identity.ts
```
Expected: prints minted identity, re-scoped ~2790, imported N new, and "DONE. dogfood scope now holds M observations" with M ≥ 2790, and no abort.

- [ ] **Step 4: Verify recall end-to-end through the new key**

After the seed, confirm `.memsmith/project.json` exists in this repo and `~/.memsmith/credentials.json` (0600) holds the key. Then verify `buildServerContext` resolves it (a focused check that a local search returns content — reuse the pattern from the local-identity-context test, or a manual `/v1/search` through the resolved key).
Expected: recall returns real observations from the re-scoped + imported corpus.

- [ ] **Step 5: Commit the script + marker (NOT the key)**

```bash
git add scripts/seed-dogfood-identity.ts .memsmith/project.json
# DO NOT add ~/.memsmith/credentials.json (it's outside the repo anyway) — double-check nothing secret is staged:
git diff --cached --name-only
git commit -m "$(printf 'chore(identity): dogfood seed script + this project marker\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

Before committing, confirm `.memsmith/project.json` contains NO key field (only teamId/projectId/note).

---

## Notes for the executor

- Tasks 1→2→3 are a dependency chain (3 consumes 2 consumes 1). Task 4 depends on 1–2. Task 5 depends on 1–3 and is a live-data migration — run it yourself with the backup, don't delegate the live run casually.
- The base key is a secret: verify at each commit that no key material is staged (`git diff --cached | grep -i msk_` should be empty). `.memsmith/project.json` is safe to commit (ids only).
- The server-side keyless bypass stays as the fallback; do not remove it.
- If `buildServerContext`'s existing body differs from the sketch, preserve its real structure and only add the `!apiKey` resolution block + options param.
