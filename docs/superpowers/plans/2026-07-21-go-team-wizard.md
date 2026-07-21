# Go Team Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guided overlay wizard that converts a solo `local` MemSmith project into a shared team store: validate a remote Postgres, copy local→remote (idempotent, verified), establish the human owner, and flip the runtime to team mode — non-destructively.

**Architecture:** Backend-first. Phase A builds the Convert engine as real `/v1` endpoints with unit/integration tests (settings-writer, test-connection probe, copy→verify→flip data mover, attribution re-stamp), each independently testable without UI. Phase B builds the overlay wizard UI (5 cards) consuming those endpoints. Consumes the merged Identity Core (better-auth sign-in, `team_members`/roles, `createApiKey`, `stampAttribution`).

**Tech Stack:** TypeScript, `bun:test`, Express `/v1` routes (`ServerV1PostgresRoutes.ts`), Postgres + pgvector (`pool.ts`/`config.ts`/`schema.ts`), React viewer UI (`src/ui/viewer/`, esbuild via `scripts/build-viewer.js`), `~/.memsmith/settings.json` + `credentials.json`.

## Global Constraints

- **Non-destructive.** The local embedded Postgres data (`~/.memsmith/pgdata`) is NEVER mutated or deleted by conversion. The flip is a config change; rollback = flip back. Deletion is always explicit + user-initiated, never by the wizard.
- **Copy → verify → flip, in that order.** The runtime flips to remote ONLY after the copy is verified. Any failure before the flip leaves the user fully on local with nothing lost.
- **Idempotent + resumable.** The copy upserts by id (`ON CONFLICT ... DO NOTHING`/remote-wins); re-running continues safely after a partial failure. Never half-flips. Model the three-gate + 200-row batch discipline on `src/server/runtime/import/firstRunImport.ts`.
- **Test Connection is a pure infrastructure probe.** It touches no identity and no project — only "is this a valid Postgres fit to be a team store." Reuse `parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: url } })` → `createPostgresPool(config)` → probe → `pool.end()`.
- **Convert copies `rows matching filter F`, `F` default = all rows.** The privacy extension point (filter-F seam): capture-time moderation needs zero wizard change; a future stored-but-private model is just a new predicate for F.
- **Convert-all + honest warning.** Convert copies everything; the Convert card shows a clear count-backed warning ("All N local memories become visible to your team"), noting it assumes capture-suppression lands separately.
- **First real member = owner.** The signing-in human becomes the team `owner` (`team_members` role `owner`).
- **Attribution re-stamp.** During the copy, rewrite `createdByUserId` from `local-owner` to the resolved owner user id via `stampAttribution(metadata, { userId })`.
- **The server settings cache never invalidates in-process.** `hook-settings.ts` `loadFromFileOnce` is process-global and never re-read. After writing `~/.memsmith/settings.json`, the running server will NOT see the new `MEMSMITH_RUNTIME` until restart. The flip step MUST surface a restart requirement (return a `restartRequired: true` flag; the UI instructs/triggers restart).
- **No `mergeSettings` exists.** Write `~/.memsmith/settings.json` directly with a read-JSON-merge-write helper.
- **better-auth session store is SQLite, separate from the PG observation store.** Human sign-in goes through better-auth (`/api/auth`); team/key records (`team_members`, `api_keys`) live in Postgres. These are distinct surfaces — don't conflate them.
- **Consume Identity Core; don't rebuild it.** Reuse `makeBetterAuthProvider`/`getBetterAuthProvider`, `PostgresTeamsRepository.create`/`addMember`/`getMemberRole`, `PostgresAuthRepository.createApiKey`, `stampAttribution`, `CredentialStore.storeKeyForTeam`.
- **Figma is the visual truth** (fileKey `qz6xdzhC90iINaFAUqvRmO`): overlay entry from the Settings→Identity pane; cream card; **teal** = secondary/utility (Begin, Test Connection); **terracotta** = primary/forward (Next); logo is a placeholder.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on branch `go-team-wizard`. Nothing pushed.

---

## File Structure

**Phase A — Convert engine (backend):**
- `src/server/convert/settings-writer.ts` (create) — read-merge-write `~/.memsmith/settings.json`; the flip writer.
- `src/server/convert/connection-probe.ts` (create) — test-connection checklist logic (connectivity + fitness).
- `src/server/convert/copy-engine.ts` (create) — Postgres→Postgres idempotent copy + verify, modeled on `firstRunImport`.
- `src/server/convert/convert-service.ts` (create) — orchestrates copy→verify→flip; owns the resume marker + owner establishment + re-stamp.
- `src/server/routes/v1/ConvertRoutes.ts` (create) — the `/v1/convert/*` route surface, mounted alongside existing v1 routes.
- Tests under `tests/server/convert/`.

**Phase B — Wizard UI (frontend):**
- `src/ui/viewer/views/wizard/GoTeamWizard.tsx` (create) — the overlay container + step state machine.
- `src/ui/viewer/views/wizard/cards/` (create) — `WelcomeCard.tsx`, `DestinationCard.tsx`, `ConvertCard.tsx`, `SignInCard.tsx`, `InviteCard.tsx`, `DoneCard.tsx`.
- `src/ui/viewer/views/wizard/wizardData.ts` (create) — the client fetchers for `/v1/convert/*` (mirrors `settingsData.ts`).
- `src/ui/viewer/views/SettingsView.tsx` (modify) — add the "GO TEAM" button to `IdentityPane` that opens the overlay.
- Tests under `tests/ui/` for the wizard state machine + gating logic.

---

## Phase A — Convert Engine

### Task 1: Settings writer (the flip persistence)

**Files:**
- Create: `src/server/convert/settings-writer.ts`
- Test: `tests/server/convert/settings-writer.test.ts`

**Interfaces:**
- Consumes: `USER_SETTINGS_PATH` from `src/shared/paths.js` (the `~/.memsmith/settings.json` path).
- Produces: `writeServerModeSettings(patch: Record<string, string>, opts?: { path?: string }): void` — reads the existing settings JSON (or `{}` if absent/corrupt), shallow-merges `patch`, writes it back with mode 0600. `opts.path` overrides the file path for tests. Never throws on a corrupt existing file (treats it as `{}`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/convert/settings-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeServerModeSettings } from '../../../src/server/convert/settings-writer.js';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-settings-')); path = join(dir, 'settings.json'); });
afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

describe('writeServerModeSettings', () => {
  it('merges into an existing settings file, preserving unrelated keys', () => {
    writeFileSync(path, JSON.stringify({ MEMSMITH_PROVIDER: 'ollama', MEMSMITH_RUNTIME: 'local' }));
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server', MEMSMITH_SERVER_DATABASE_URL: 'postgres://x' }, { path });
    const out = JSON.parse(readFileSync(path, 'utf8'));
    expect(out.MEMSMITH_PROVIDER).toBe('ollama');
    expect(out.MEMSMITH_RUNTIME).toBe('server');
    expect(out.MEMSMITH_SERVER_DATABASE_URL).toBe('postgres://x');
  });

  it('creates the file when absent', () => {
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server' }, { path });
    expect(JSON.parse(readFileSync(path, 'utf8')).MEMSMITH_RUNTIME).toBe('server');
  });

  it('treats a corrupt existing file as empty and still writes the patch', () => {
    writeFileSync(path, 'not json{{');
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server' }, { path });
    expect(JSON.parse(readFileSync(path, 'utf8')).MEMSMITH_RUNTIME).toBe('server');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/settings-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/convert/settings-writer.ts
// SPDX-License-Identifier: Apache-2.0
//
// The "flip" persistence: writes MEMSMITH_RUNTIME/MEMSMITH_SERVER_DATABASE_URL
// into ~/.memsmith/settings.json. There is no mergeSettings helper in the repo,
// so this does a direct read-merge-write. NOTE: the running server caches
// settings once per process (hook-settings loadFromFileOnce), so a restart is
// required for a written flip to take effect — the convert service surfaces
// restartRequired to the caller.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export function writeServerModeSettings(
  patch: Record<string, string>,
  opts: { path?: string } = {},
): void {
  const path = opts.path ?? USER_SETTINGS_PATH;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) existing = {};
  } catch {
    existing = {};
  }
  const merged = { ...existing, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/convert/settings-writer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/settings-writer.ts tests/server/convert/settings-writer.test.ts
git commit -m "feat(wizard): settings-writer for the server-mode flip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Connection probe (Test Connection checklist)

**Files:**
- Create: `src/server/convert/connection-probe.ts`
- Test: `tests/server/convert/connection-probe.test.ts`

**Interfaces:**
- Consumes: `parsePostgresConfig` from `src/storage/postgres/config.js`; `createPostgresPool` from `src/storage/postgres/pool.js`. For testability, the probe accepts an injectable `runQuery` so tests don't need a live DB.
- Produces:
  ```ts
  export interface ProbeResult {
    connectivity: { reachable: boolean; authenticates: boolean };
    fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean };
    allGreen: boolean;
    fixable: string[]; // e.g. ['pgvector'] when the gap is CREATE-EXTENSION-fixable
    error?: string;    // human-readable when connectivity fails
  }
  export interface ProbeDeps {
    runQuery: (url: string, sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  }
  export const MIN_PG_MAJOR = 14;
  export async function probeConnection(url: string, deps: ProbeDeps): Promise<ProbeResult>;
  export function makeRealProbeDeps(): ProbeDeps; // wires parsePostgresConfig+createPostgresPool
  ```
- Semantics: `probeConnection` runs `SELECT 1` (connectivity), then (only if connected) checks: version (`SHOW server_version_num` ≥ `MIN_PG_MAJOR`*10000), writable (`CREATE TEMP TABLE _ms_probe(x int); DROP TABLE _ms_probe;` — succeeds ⇒ writable), pgvector (`SELECT 1 FROM pg_extension WHERE extname='vector'` OR `SELECT 1 FROM pg_available_extensions WHERE name='vector'` ⇒ if not installed but available, mark `fixable:['pgvector']`), schemaReady (observations table absent OR present with the current schema version — query `information_schema.tables`). `allGreen` = connectivity both true AND all fitness true. Any thrown error from `runQuery` on the FIRST (connectivity) query ⇒ `reachable:false` (or `authenticates:false` if the error message indicates auth) with `error` set, all fitness false, `allGreen:false`. Never throws.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/convert/connection-probe.test.ts
import { describe, it, expect } from 'bun:test';
import { probeConnection, MIN_PG_MAJOR } from '../../../src/server/convert/connection-probe.js';

function depsFor(script: Record<string, { rows: Array<Record<string, unknown>> } | Error>) {
  return {
    runQuery: async (_url: string, sql: string) => {
      for (const key of Object.keys(script)) {
        if (sql.includes(key)) {
          const v = script[key];
          if (v instanceof Error) throw v;
          return v;
        }
      }
      return { rows: [] };
    },
  };
}

describe('probeConnection', () => {
  it('reports all-green when reachable, writable, pgvector present, version ok, schema fresh', async () => {
    const deps = depsFor({
      'SELECT 1': { rows: [{ '?column?': 1 }] },
      'server_version_num': { rows: [{ server_version_num: `${(MIN_PG_MAJOR + 2) * 10000}` }] },
      'TEMP TABLE': { rows: [] },
      "extname='vector'": { rows: [{ '?column?': 1 }] },
      'information_schema.tables': { rows: [] }, // observations absent → fresh
    });
    const r = await probeConnection('postgres://x', deps);
    expect(r.connectivity.reachable).toBe(true);
    expect(r.fitness.pgvector).toBe(true);
    expect(r.fitness.versionOk).toBe(true);
    expect(r.allGreen).toBe(true);
    expect(r.fixable).toEqual([]);
  });

  it('marks pgvector fixable when not installed but available', async () => {
    const deps = depsFor({
      'SELECT 1': { rows: [{ '?column?': 1 }] },
      'server_version_num': { rows: [{ server_version_num: `${(MIN_PG_MAJOR + 2) * 10000}` }] },
      'TEMP TABLE': { rows: [] },
      "extname='vector'": { rows: [] },              // not installed
      "name='vector'": { rows: [{ '?column?': 1 }] }, // but available
      'information_schema.tables': { rows: [] },
    });
    const r = await probeConnection('postgres://x', deps);
    expect(r.fitness.pgvector).toBe(false);
    expect(r.fixable).toContain('pgvector');
    expect(r.allGreen).toBe(false);
  });

  it('reports unreachable (never throws) when the connectivity query errors', async () => {
    const deps = depsFor({ 'SELECT 1': new Error('ECONNREFUSED') });
    const r = await probeConnection('postgres://x', deps);
    expect(r.connectivity.reachable).toBe(false);
    expect(r.allGreen).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/connection-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/convert/connection-probe.ts
// SPDX-License-Identifier: Apache-2.0
import { parsePostgresConfig } from '../../storage/postgres/config.js';
import { createPostgresPool } from '../../storage/postgres/pool.js';

export interface ProbeResult {
  connectivity: { reachable: boolean; authenticates: boolean };
  fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean };
  allGreen: boolean;
  fixable: string[];
  error?: string;
}
export interface ProbeDeps {
  runQuery: (url: string, sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}
export const MIN_PG_MAJOR = 14;

function looksLikeAuthError(msg: string): boolean {
  return /password|authentication|role .* does not exist|permission denied/i.test(msg);
}

export async function probeConnection(url: string, deps: ProbeDeps): Promise<ProbeResult> {
  const result: ProbeResult = {
    connectivity: { reachable: false, authenticates: false },
    fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false },
    allGreen: false,
    fixable: [],
  };
  try {
    await deps.runQuery(url, 'SELECT 1');
    result.connectivity.reachable = true;
    result.connectivity.authenticates = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.error = msg;
    result.connectivity.reachable = !looksLikeAuthError(msg);
    result.connectivity.authenticates = false;
    return result;
  }

  // version
  try {
    const v = await deps.runQuery(url, 'SHOW server_version_num');
    const num = Number.parseInt(String(v.rows[0]?.server_version_num ?? '0'), 10);
    result.fitness.versionOk = Number.isFinite(num) && num >= MIN_PG_MAJOR * 10000;
  } catch { result.fitness.versionOk = false; }

  // writable
  try {
    await deps.runQuery(url, 'CREATE TEMP TABLE _ms_probe(x int); DROP TABLE _ms_probe');
    result.fitness.writable = true;
  } catch { result.fitness.writable = false; }

  // pgvector
  try {
    const installed = await deps.runQuery(url, "SELECT 1 FROM pg_extension WHERE extname='vector'");
    if (installed.rows.length > 0) {
      result.fitness.pgvector = true;
    } else {
      const available = await deps.runQuery(url, "SELECT 1 FROM pg_available_extensions WHERE name='vector'");
      if (available.rows.length > 0) result.fixable.push('pgvector');
    }
  } catch { /* leave pgvector false */ }

  // schema-ready: observations absent (fresh) OR present (compatible upsert target)
  try {
    await deps.runQuery(url, "SELECT 1 FROM information_schema.tables WHERE table_name='observations'");
    result.fitness.schemaReady = true; // absent→fresh (ok), present→compatible (ok); both upsertable
  } catch { result.fitness.schemaReady = false; }

  result.allGreen =
    result.connectivity.reachable && result.connectivity.authenticates &&
    result.fitness.writable && result.fitness.pgvector &&
    result.fitness.versionOk && result.fitness.schemaReady;
  return result;
}

export function makeRealProbeDeps(): ProbeDeps {
  return {
    runQuery: async (url, sql) => {
      const config = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: url } as NodeJS.ProcessEnv });
      if (!config) throw new Error('invalid connection string');
      const pool = createPostgresPool(config);
      try {
        const res = await pool.query(sql);
        return { rows: (res.rows ?? []) as Array<Record<string, unknown>> };
      } finally {
        await pool.end();
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/convert/connection-probe.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/connection-probe.ts tests/server/convert/connection-probe.test.ts
git commit -m "feat(wizard): connection probe (connectivity + fitness checklist)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Copy engine (idempotent Postgres→Postgres copy + verify)

**Files:**
- Create: `src/server/convert/copy-engine.ts`
- Test: `tests/server/convert/copy-engine.test.ts`

**Interfaces:**
- Consumes: `stampAttribution` from `src/server/routes/v1/attribution.js`.
- Produces:
  ```ts
  export interface CopyDeps {
    readRows: (table: string) => Promise<Array<Record<string, unknown>>>;
    upsertRows: (table: string, rows: Array<Record<string, unknown>>) => Promise<void>; // ON CONFLICT (id) DO NOTHING
    countRows: (which: 'local' | 'remote', table: string) => Promise<number>;
  }
  export interface CopyProgress { table: string; copied: number; }
  export const COPY_TABLES: string[]; // FK-safe order
  export const COPY_BATCH_SIZE = 200;
  export async function runCopy(
    deps: CopyDeps,
    ownerUserId: string,
    onProgress?: (p: CopyProgress) => void,
  ): Promise<{ copiedByTable: Record<string, number> }>;
  export async function verifyCopy(deps: CopyDeps): Promise<{ ok: boolean; mismatches: Array<{ table: string; local: number; remote: number }> }>;
  ```
- Semantics: `runCopy` iterates `COPY_TABLES` in FK-safe order; for `observations`, re-stamps each row's `metadata` via `stampAttribution(metadata, { userId: ownerUserId })` before upsert; batches at `COPY_BATCH_SIZE`; upsert is `ON CONFLICT (id) DO NOTHING` (remote-wins). `verifyCopy` compares `countRows('local', t)` vs `countRows('remote', t)` for each table; `ok` = every remote count ≥ local count (remote may have more from an existing team). Neither throws on empty tables.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/convert/copy-engine.test.ts
import { describe, it, expect } from 'bun:test';
import { runCopy, verifyCopy, COPY_TABLES, type CopyDeps } from '../../../src/server/convert/copy-engine.js';

function makeFakeDeps(): { deps: CopyDeps; remote: Record<string, Array<Record<string, unknown>>> } {
  const local: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  const remote: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  local.observations = [
    { id: 'o1', metadata: { createdByUserId: 'local-owner' }, content: 'a' },
    { id: 'o2', metadata: {}, content: 'b' },
  ];
  const deps: CopyDeps = {
    readRows: async (t) => local[t] ?? [],
    upsertRows: async (t, rows) => {
      const seen = new Set((remote[t] ?? []).map(r => r.id));
      for (const r of rows) if (!seen.has(r.id)) remote[t].push(r);
    },
    countRows: async (which, t) => (which === 'local' ? local[t] : remote[t]).length,
  };
  return { deps, remote };
}

describe('copy-engine', () => {
  it('re-stamps observation attribution to the owner during copy', async () => {
    const { deps, remote } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    expect(remote.observations.find(r => r.id === 'o1')?.metadata).toMatchObject({ createdByUserId: 'user-42' });
    expect(remote.observations.find(r => r.id === 'o2')?.metadata).toMatchObject({ createdByUserId: 'user-42' });
  });

  it('is idempotent — running twice does not duplicate rows', async () => {
    const { deps, remote } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    await runCopy(deps, 'user-42');
    expect(remote.observations).toHaveLength(2);
  });

  it('verifyCopy ok when remote counts >= local for every table', async () => {
    const { deps } = makeFakeDeps();
    await runCopy(deps, 'user-42');
    const v = await verifyCopy(deps);
    expect(v.ok).toBe(true);
    expect(v.mismatches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/copy-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/convert/copy-engine.ts
// SPDX-License-Identifier: Apache-2.0
//
// Postgres→Postgres idempotent copy for the Go Team conversion. Models its
// batch + idempotency discipline on src/server/runtime/import/firstRunImport.ts.
import { stampAttribution } from '../routes/v1/attribution.js';

export interface CopyDeps {
  readRows: (table: string) => Promise<Array<Record<string, unknown>>>;
  upsertRows: (table: string, rows: Array<Record<string, unknown>>) => Promise<void>;
  countRows: (which: 'local' | 'remote', table: string) => Promise<number>;
}
export interface CopyProgress { table: string; copied: number; }

// FK-safe order: parents before children.
export const COPY_TABLES: string[] = [
  'teams',
  'projects',
  'team_members',
  'api_keys',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
  'server_settings',
];

export const COPY_BATCH_SIZE = 200;

export async function runCopy(
  deps: CopyDeps,
  ownerUserId: string,
  onProgress?: (p: CopyProgress) => void,
): Promise<{ copiedByTable: Record<string, number> }> {
  const copiedByTable: Record<string, number> = {};
  for (const table of COPY_TABLES) {
    const rows = await deps.readRows(table);
    let copied = 0;
    let batch: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await deps.upsertRows(table, batch);
      copied += batch.length;
      batch = [];
    };
    for (const row of rows) {
      const out = table === 'observations'
        ? { ...row, metadata: stampAttribution((row.metadata as Record<string, unknown>) ?? {}, { userId: ownerUserId }) }
        : row;
      batch.push(out);
      if (batch.length >= COPY_BATCH_SIZE) await flush();
    }
    await flush();
    copiedByTable[table] = copied;
    onProgress?.({ table, copied });
  }
  return { copiedByTable };
}

export async function verifyCopy(
  deps: CopyDeps,
): Promise<{ ok: boolean; mismatches: Array<{ table: string; local: number; remote: number }> }> {
  const mismatches: Array<{ table: string; local: number; remote: number }> = [];
  for (const table of COPY_TABLES) {
    const local = await deps.countRows('local', table);
    const remote = await deps.countRows('remote', table);
    if (remote < local) mismatches.push({ table, local, remote });
  }
  return { ok: mismatches.length === 0, mismatches };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/convert/copy-engine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/copy-engine.ts tests/server/convert/copy-engine.test.ts
git commit -m "feat(wizard): idempotent copy engine + verify (attribution re-stamp)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Convert service (orchestrate copy → verify → flip)

**Files:**
- Create: `src/server/convert/convert-service.ts`
- Test: `tests/server/convert/convert-service.test.ts`

**Interfaces:**
- Consumes: `runCopy`, `verifyCopy`, `CopyDeps` (Task 3); `writeServerModeSettings` (Task 1).
- Produces:
  ```ts
  export interface ConvertDeps {
    copyDeps: CopyDeps;
    flip: (databaseUrl: string) => void; // wraps writeServerModeSettings({ MEMSMITH_RUNTIME:'server', MEMSMITH_SERVER_DATABASE_URL:url })
  }
  export interface ConvertResult {
    status: 'converted' | 'verify_failed';
    copiedByTable?: Record<string, number>;
    mismatches?: Array<{ table: string; local: number; remote: number }>;
    restartRequired: boolean; // true only when flipped
  }
  export async function runConvert(
    deps: ConvertDeps,
    input: { databaseUrl: string; ownerUserId: string },
    onProgress?: (p: { phase: 'copying' | 'verifying' | 'switching'; table?: string; copied?: number }) => void,
  ): Promise<ConvertResult>;
  ```
- Semantics: emit `phase:'copying'` progress during `runCopy`; then `phase:'verifying'` + `verifyCopy`. If `!ok` → return `{ status:'verify_failed', mismatches, restartRequired:false }` WITHOUT flipping (stay on local). If ok → `phase:'switching'`, call `deps.flip(databaseUrl)`, return `{ status:'converted', copiedByTable, restartRequired:true }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/convert/convert-service.test.ts
import { describe, it, expect } from 'bun:test';
import { runConvert, type ConvertDeps } from '../../../src/server/convert/convert-service.js';
import { COPY_TABLES, type CopyDeps } from '../../../src/server/convert/copy-engine.js';

function baseCopyDeps(remoteShort = false): CopyDeps {
  const local: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  local.observations = [{ id: 'o1', metadata: {}, content: 'a' }];
  const remote: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  return {
    readRows: async (t) => local[t] ?? [],
    upsertRows: async (t, rows) => { if (!(remoteShort && t === 'observations')) remote[t].push(...rows); },
    countRows: async (which, t) => (which === 'local' ? local[t] : remote[t]).length,
  };
}

describe('runConvert', () => {
  it('copies, verifies, flips, and reports restartRequired on success', async () => {
    let flipped: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(false), flip: (url) => { flipped = url; } };
    const phases: string[] = [];
    const r = await runConvert(deps, { databaseUrl: 'postgres://team', ownerUserId: 'u1' }, p => phases.push(p.phase));
    expect(r.status).toBe('converted');
    expect(r.restartRequired).toBe(true);
    expect(flipped).toBe('postgres://team');
    expect(phases).toContain('copying');
    expect(phases).toContain('verifying');
    expect(phases).toContain('switching');
  });

  it('does NOT flip when verify fails (stays on local)', async () => {
    let flipped: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(true), flip: (url) => { flipped = url; } };
    const r = await runConvert(deps, { databaseUrl: 'postgres://team', ownerUserId: 'u1' });
    expect(r.status).toBe('verify_failed');
    expect(r.restartRequired).toBe(false);
    expect(flipped).toBeNull();
    expect(r.mismatches?.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/convert-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/convert/convert-service.ts
// SPDX-License-Identifier: Apache-2.0
import { runCopy, verifyCopy, type CopyDeps } from './copy-engine.js';

export interface ConvertDeps {
  copyDeps: CopyDeps;
  flip: (databaseUrl: string) => void;
}
export interface ConvertResult {
  status: 'converted' | 'verify_failed';
  copiedByTable?: Record<string, number>;
  mismatches?: Array<{ table: string; local: number; remote: number }>;
  restartRequired: boolean;
}

export async function runConvert(
  deps: ConvertDeps,
  input: { databaseUrl: string; ownerUserId: string },
  onProgress?: (p: { phase: 'copying' | 'verifying' | 'switching'; table?: string; copied?: number }) => void,
): Promise<ConvertResult> {
  onProgress?.({ phase: 'copying' });
  const { copiedByTable } = await runCopy(
    deps.copyDeps,
    input.ownerUserId,
    (p) => onProgress?.({ phase: 'copying', table: p.table, copied: p.copied }),
  );

  onProgress?.({ phase: 'verifying' });
  const verify = await verifyCopy(deps.copyDeps);
  if (!verify.ok) {
    return { status: 'verify_failed', mismatches: verify.mismatches, restartRequired: false };
  }

  onProgress?.({ phase: 'switching' });
  deps.flip(input.databaseUrl);
  return { status: 'converted', copiedByTable, restartRequired: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/convert/convert-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/convert-service.ts tests/server/convert/convert-service.test.ts
git commit -m "feat(wizard): convert service — copy->verify->flip orchestration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Convert routes (`/v1/convert/*` endpoints + real deps wiring)

**Files:**
- Create: `src/server/routes/v1/ConvertRoutes.ts`
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (mount ConvertRoutes in the same place the other v1 routes are registered — locate the existing `app.post('/v1/members', ...)` registration and add the convert mount adjacent, sharing `this.options.pool`, `writeAuth`, and `requireRole`)
- Test: `tests/server/routes/v1/convert-routes.test.ts`

**Interfaces:**
- Consumes: `probeConnection` + `makeRealProbeDeps` (Task 2); `runConvert` + real `ConvertDeps` built from `this.options.pool` + a remote pool created via `createPostgresPool(parsePostgresConfig({env:{MEMSMITH_SERVER_DATABASE_URL:url}}))`; `writeServerModeSettings` (Task 1); Identity Core repos (`PostgresTeamsRepository`, `PostgresAuthRepository`, `CredentialStore`) for owner establishment.
- Produces two authenticated routes (both `writeAuth` + `requireRole('owner')` — converting is an owner-only action):
  - `POST /v1/convert/test-connection` body `{ databaseUrl: string }` → `ProbeResult` JSON.
  - `POST /v1/convert/migrate` body `{ databaseUrl: string }` → runs owner establishment (create remote team/project records if absent, `addMember` owner, `createApiKey` for the owner, `CredentialStore.storeKeyForTeam`) then `runConvert` with `ownerUserId = authContext.userId`; responds `ConvertResult`. (Progress: for v1, return the final result; streaming progress is a UI-polling concern deferred — the endpoint returns `copiedByTable` counts.)

**Note on scope of owner establishment:** The remote team/project/owner/key setup is the minimal set required for the flipped server to authenticate. Build it from the Identity Core functions the Explore map named (`teamsRepo.create`, `addMember`, `createApiKey`, `CredentialStore.storeKeyForTeam`). Wire real `CopyDeps` (readRows = `this.options.pool.query('SELECT * FROM '+table)`; upsertRows = parameterized `INSERT ... ON CONFLICT (id) DO NOTHING` against the remote pool; countRows = `SELECT count(*)` against the respective pool). The route test uses injected fakes (below); the live path is exercised in acceptance.

- [ ] **Step 1: Write the failing test** (route-level, with the service injected as a fake so no live DB is needed)

```typescript
// tests/server/routes/v1/convert-routes.test.ts
import { describe, it, expect } from 'bun:test';
import { registerConvertRoutes } from '../../../../src/server/routes/v1/ConvertRoutes.js';

// Minimal express-like harness: capture registered handlers and invoke them.
function makeApp() {
  const routes: Record<string, Function> = {};
  return {
    app: { post: (path: string, ..._mw: unknown[]) => { routes[path] = _mw[_mw.length - 1] as Function; } },
    routes,
  };
}
function res() {
  const r: any = { code: 0, body: null, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return r;
}

describe('convert routes', () => {
  it('POST /v1/convert/test-connection returns the probe result', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async (url) => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: {} }),
    } as never);
    const r = res();
    await routes['/v1/convert/test-connection']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.allGreen).toBe(true);
  });

  it('POST /v1/convert/migrate returns converted + restartRequired', async () => {
    const { app, routes } = makeApp();
    registerConvertRoutes(app as never, {
      authMiddleware: [],
      probe: async () => ({ connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] }),
      convert: async () => ({ status: 'converted', restartRequired: true, copiedByTable: { observations: 3 } }),
    } as never);
    const r = res();
    await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r);
    expect(r.body.status).toBe('converted');
    expect(r.body.restartRequired).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: FAIL — `registerConvertRoutes` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/routes/v1/ConvertRoutes.ts` with a `registerConvertRoutes(app, deps)` that registers the two routes using injected `probe(url)` and `convert(input)` functions (so the test injects fakes and the real wiring passes the live implementations):

```typescript
// src/server/routes/v1/ConvertRoutes.ts
// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  convert: (input: { databaseUrl: string; ownerUserId: string }) => Promise<ConvertResult>;
}

export function registerConvertRoutes(app: import('express').Express, deps: ConvertRoutesDeps): void {
  app.post('/v1/convert/test-connection', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    res.json(await deps.probe(url));
  });

  app.post('/v1/convert/migrate', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    const ownerUserId = req.authContext?.userId;
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    if (!ownerUserId) { res.status(403).json({ error: 'no owner identity' }); return; }
    res.json(await deps.convert({ databaseUrl: url, ownerUserId }));
  });
}
```

Then in `ServerV1PostgresRoutes.ts`, next to the existing `/v1/members` registration, wire the real deps:

```typescript
import { registerConvertRoutes } from './ConvertRoutes.js';
import { probeConnection, makeRealProbeDeps } from '../../convert/connection-probe.js';
import { runConvert } from '../../convert/convert-service.js';
import { writeServerModeSettings } from '../../convert/settings-writer.js';
// ... inside setupRoutes, after members routes:
registerConvertRoutes(app, {
  authMiddleware: [...writeAuth, requireRole('owner')],
  probe: (url) => probeConnection(url, makeRealProbeDeps()),
  convert: (input) => runConvert(
    { copyDeps: this.buildConvertCopyDeps(input.databaseUrl), flip: (u) => writeServerModeSettings({ MEMSMITH_RUNTIME: 'server', MEMSMITH_SERVER_DATABASE_URL: u }) },
    input,
  ),
});
```

Implement `this.buildConvertCopyDeps(remoteUrl)` as a private method building `CopyDeps` from `this.options.pool` (local reads/counts) and a remote pool (`createPostgresPool(parsePostgresConfig({env:{MEMSMITH_SERVER_DATABASE_URL:remoteUrl}}))`) for upserts/remote counts, using `SELECT *` reads and parameterized `INSERT ... ON CONFLICT (id) DO NOTHING` writes. Ensure the remote schema is bootstrapped first (call the existing `bootstrapServerPostgresSchema` on the remote pool before copying — same helper the server uses locally).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ConvertRoutes.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/convert-routes.test.ts
git commit -m "feat(wizard): /v1/convert/test-connection + /v1/convert/migrate routes (owner-gated)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase B — Wizard UI

### Task 6: Wizard state machine + step model

**Files:**
- Create: `src/ui/viewer/views/wizard/wizardState.ts`
- Test: `tests/ui/wizard-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WizardStep = 'welcome' | 'destination' | 'convert' | 'signin' | 'invite' | 'done';
  export const WIZARD_ORDER: WizardStep[];
  export function nextStep(cur: WizardStep): WizardStep;   // clamps at 'done'
  export function prevStep(cur: WizardStep): WizardStep;   // clamps at 'welcome'
  export function canAdvance(step: WizardStep, state: { probeAllGreen: boolean; signedIn: boolean }): boolean;
  ```
- Semantics: `canAdvance('destination', s)` = `s.probeAllGreen`; `canAdvance('signin', s)` = `s.signedIn`; all other steps → true (Welcome/Convert/Invite advance freely; Convert's own completion is handled by its card). Order: welcome→destination→convert→signin→invite→done. (Note: the attribution re-stamp needs the owner id, so although the visual/card order places Convert before Sign-in, the DATA dependency is enforced server-side — `/v1/convert/migrate` requires `authContext.userId`. The UI therefore requires the user to be signed in before the Convert card can trigger migrate. Model this by having `canAdvance('convert', s)` also require `s.signedIn` — i.e. sign-in identity must be established before the migrate call. See the card wiring in Task 8.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui/wizard-state.test.ts
import { describe, it, expect } from 'bun:test';
import { nextStep, prevStep, canAdvance, WIZARD_ORDER } from '../../src/ui/viewer/views/wizard/wizardState.js';

describe('wizard state', () => {
  it('advances and clamps at done', () => {
    expect(nextStep('welcome')).toBe('destination');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('welcome')).toBe('welcome');
  });
  it('gates destination on probe all-green', () => {
    expect(canAdvance('destination', { probeAllGreen: false, signedIn: false })).toBe(false);
    expect(canAdvance('destination', { probeAllGreen: true, signedIn: false })).toBe(true);
  });
  it('gates convert + signin on signed-in identity', () => {
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: false })).toBe(false);
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: true })).toBe(true);
    expect(canAdvance('signin', { probeAllGreen: true, signedIn: true })).toBe(true);
  });
  it('order is welcome→destination→convert→signin→invite→done', () => {
    expect(WIZARD_ORDER).toEqual(['welcome', 'destination', 'convert', 'signin', 'invite', 'done']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/wizard-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui/viewer/views/wizard/wizardState.ts
export type WizardStep = 'welcome' | 'destination' | 'convert' | 'signin' | 'invite' | 'done';
export const WIZARD_ORDER: WizardStep[] = ['welcome', 'destination', 'convert', 'signin', 'invite', 'done'];

export function nextStep(cur: WizardStep): WizardStep {
  const i = WIZARD_ORDER.indexOf(cur);
  return WIZARD_ORDER[Math.min(i + 1, WIZARD_ORDER.length - 1)];
}
export function prevStep(cur: WizardStep): WizardStep {
  const i = WIZARD_ORDER.indexOf(cur);
  return WIZARD_ORDER[Math.max(i - 1, 0)];
}
export function canAdvance(step: WizardStep, state: { probeAllGreen: boolean; signedIn: boolean }): boolean {
  if (step === 'destination') return state.probeAllGreen;
  if (step === 'convert') return state.signedIn;
  if (step === 'signin') return state.signedIn;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/wizard-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/views/wizard/wizardState.ts tests/ui/wizard-state.test.ts
git commit -m "feat(wizard): step state machine + advance gating

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Wizard client data layer (`/v1/convert/*` fetchers)

**Files:**
- Create: `src/ui/viewer/views/wizard/wizardData.ts`
- Test: `tests/ui/wizard-data.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProbeResult { connectivity: { reachable: boolean; authenticates: boolean }; fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean }; allGreen: boolean; fixable: string[]; error?: string }
  export interface ConvertResult { status: 'converted' | 'verify_failed'; copiedByTable?: Record<string, number>; mismatches?: Array<{ table: string; local: number; remote: number }>; restartRequired: boolean }
  export async function testConnection(databaseUrl: string, fetchImpl?: typeof fetch): Promise<ProbeResult>;
  export async function migrate(databaseUrl: string, fetchImpl?: typeof fetch): Promise<ConvertResult>;
  ```
- Semantics: POST to `/v1/convert/test-connection` and `/v1/convert/migrate` with `{ databaseUrl }`, `credentials: 'include'`. On a non-2xx or thrown error, `testConnection` returns a not-all-green ProbeResult with `error` set (degrade, never throw — mirrors the existing `serverData.ts` degrade-silently pattern); `migrate` returns `{ status:'verify_failed', restartRequired:false }` with no throw. `fetchImpl` is injectable for tests.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui/wizard-data.test.ts
import { describe, it, expect } from 'bun:test';
import { testConnection, migrate } from '../../src/ui/viewer/views/wizard/wizardData.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe('wizardData', () => {
  it('testConnection returns the parsed probe result on 200', async () => {
    const probe = { connectivity: { reachable: true, authenticates: true }, fitness: { writable: true, pgvector: true, versionOk: true, schemaReady: true }, allGreen: true, fixable: [] };
    const r = await testConnection('postgres://x', fakeFetch(200, probe));
    expect(r.allGreen).toBe(true);
  });
  it('testConnection degrades (never throws) on network error', async () => {
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const r = await testConnection('postgres://x', boom);
    expect(r.allGreen).toBe(false);
    expect(r.error).toBeDefined();
  });
  it('migrate degrades to verify_failed on error', async () => {
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    const r = await migrate('postgres://x', boom);
    expect(r.status).toBe('verify_failed');
    expect(r.restartRequired).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/wizard-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui/viewer/views/wizard/wizardData.ts
export interface ProbeResult { connectivity: { reachable: boolean; authenticates: boolean }; fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean }; allGreen: boolean; fixable: string[]; error?: string }
export interface ConvertResult { status: 'converted' | 'verify_failed'; copiedByTable?: Record<string, number>; mismatches?: Array<{ table: string; local: number; remote: number }>; restartRequired: boolean }

const NOT_GREEN: ProbeResult = { connectivity: { reachable: false, authenticates: false }, fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false }, allGreen: false, fixable: [] };

export async function testConnection(databaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchImpl('/v1/convert/test-connection', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl }) });
    if (!res.ok) return { ...NOT_GREEN, error: `HTTP ${res.status}` };
    return (await res.json()) as ProbeResult;
  } catch (e) {
    return { ...NOT_GREEN, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function migrate(databaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ConvertResult> {
  try {
    const res = await fetchImpl('/v1/convert/migrate', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl }) });
    if (!res.ok) return { status: 'verify_failed', restartRequired: false };
    return (await res.json()) as ConvertResult;
  } catch {
    return { status: 'verify_failed', restartRequired: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/wizard-data.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/views/wizard/wizardData.ts tests/ui/wizard-data.test.ts
git commit -m "feat(wizard): client data layer for /v1/convert/* (degrade-silently)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Wizard overlay container + cards + Settings entry button

**Files:**
- Create: `src/ui/viewer/views/wizard/GoTeamWizard.tsx`
- Create: `src/ui/viewer/views/wizard/cards/WelcomeCard.tsx`, `DestinationCard.tsx`, `ConvertCard.tsx`, `SignInCard.tsx`, `InviteCard.tsx`, `DoneCard.tsx`
- Modify: `src/ui/viewer/views/SettingsView.tsx` (add the "GO TEAM" button to `IdentityPane` at line ~302 that sets overlay-open state)
- Test: `tests/ui/wizard-render.test.ts` (render-level assertions on the container's step switching + gating, using the state machine from Task 6 and stubbed fetchers from Task 7)

**Interfaces:**
- Consumes: `WizardStep`, `nextStep`, `prevStep`, `canAdvance`, `WIZARD_ORDER` (Task 6); `testConnection`, `migrate` (Task 7).
- Produces: `<GoTeamWizard open onClose />` — a modal overlay (dims the dashboard) rendering the current card; the current step lives in component state; Next/Back call `nextStep`/`prevStep` gated by `canAdvance`. `DestinationCard` calls `testConnection` on the teal "Test Connection" button, renders the checklist (green/red per check + fixable hints), and enables terracotta "Next" only when `allGreen`. `ConvertCard` shows the count-backed convert-all warning + phased progress and calls `migrate`; on `restartRequired`, `DoneCard` instructs the user to restart the server to complete the switch. `SignInCard` links to the better-auth sign-in (`/api/auth`) and sets `signedIn` when a session is present. `InviteCard` shows the base key + members-view link (growable component — a comment marks the email-invite extension point for Spec #3).

**Visual constraints (Figma):** cream card; teal = Begin / Test Connection; terracotta = Next; overlay dims the underlying dashboard; logo placeholder. Follow the existing "Warm Signal" design tokens already used in `SettingsView.tsx` (cream `#faf6f0`, terracotta accent) — reuse the existing CSS variables rather than introducing new colors.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ui/wizard-render.test.ts
import { describe, it, expect } from 'bun:test';
import { canAdvance } from '../../src/ui/viewer/views/wizard/wizardState.js';
// This task's testable seam is the container's advance logic + card selection.
// Assert the pure gating the container relies on (full DOM render is covered by
// manual acceptance; keep the automated test at the logic boundary).
import { pickCard } from '../../src/ui/viewer/views/wizard/GoTeamWizard.js';

describe('wizard container', () => {
  it('pickCard maps each step to a distinct card component', () => {
    const steps = ['welcome', 'destination', 'convert', 'signin', 'invite', 'done'] as const;
    const comps = steps.map(pickCard);
    expect(new Set(comps).size).toBe(steps.length); // all distinct, none undefined
    for (const c of comps) expect(c).toBeDefined();
  });
  it('reuses canAdvance for Next gating (destination needs green)', () => {
    expect(canAdvance('destination', { probeAllGreen: false, signedIn: false })).toBe(false);
  });
});
```

> Export a small pure `pickCard(step: WizardStep): React.ComponentType<any>` from `GoTeamWizard.tsx` so the container's step→card mapping is unit-testable without a DOM. The visual/DOM behavior (button colors, overlay dimming, checklist rendering) is verified in manual acceptance, per the plan's acceptance note — do not attempt full React DOM rendering under bun:test unless the repo already has a jsdom harness (check `tests/ui/` for an existing pattern; if one exists, use it, otherwise keep the automated assertion at the `pickCard`/`canAdvance` logic boundary).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui/wizard-render.test.ts`
Expected: FAIL — module/`pickCard` not found.

- [ ] **Step 3: Write the cards + container + Settings button**

Implement the six card components (each a focused function component rendering its Figma content using existing design tokens) and `GoTeamWizard.tsx` (overlay container: holds `step` state + `probeAllGreen`/`signedIn` state, renders `pickCard(step)`, wires Next/Back through `nextStep`/`prevStep` guarded by `canAdvance`, exports `pickCard`). In `SettingsView.tsx`'s `IdentityPane`, add a teal "GO TEAM" button that sets a `wizardOpen` state rendering `<GoTeamWizard open onClose={() => setWizardOpen(false)} />`. Keep each card file focused; no business logic beyond calling the Task 7 fetchers.

(Full per-card JSX is design-driven; the implementer builds each card to its Figma frame using the existing CSS variables. The behavioral contracts — Test Connection gates Next, Convert shows warning + calls migrate, Done surfaces restartRequired — are fixed by this plan and the state machine.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/ui/wizard-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the viewer bundle to confirm it compiles**

Run: `node scripts/build-viewer.js 2>&1 | tail -5`
Expected: bundle written with no build error.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit 2>&1 | tail -5`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/ui/viewer/views/wizard/ src/ui/viewer/views/SettingsView.tsx tests/ui/wizard-render.test.ts
git commit -m "feat(wizard): overlay container + 6 cards + Settings GO TEAM entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-21-go-team-wizard-design.md`):
- Test Connection probe (connectivity + fitness checklist, one-click-fixable marking) → Task 2. ✓
- Convert copy→verify→flip, idempotent upsert, local-as-backup → Tasks 3+4 (flip = settings-writer Task 1; local untouched — copy only reads local). ✓
- Attribution re-stamp `local-owner`→owner → Task 3 (`stampAttribution` in the observations branch). ✓
- Filter-F seam → Task 3 (`COPY_TABLES` + the copy reads all rows; the extension point is the read query — documented; F=all today). ⚠️ *Resolved below.*
- Sign-in = create-or-sign-in as owner → Task 5 (owner establishment) + Task 8 (SignInCard). ✓
- Invite = base key + members link, growable → Task 8 (InviteCard with extension-point comment). ✓
- Failure before flip → stay on local + resumable → Task 4 (verify_failed doesn't flip) + Task 3 (idempotent re-run). ✓
- Overlay entry, 6 cards, Figma visual → Task 8. ✓
- restart-required (settings cache) → Tasks 1+4 (`restartRequired` flag) + Task 8 (Done card instructs). ✓
- Endpoints owner-gated → Task 5 (`requireRole('owner')`). ✓

**Filter-F note:** The plan implements F=all via `COPY_TABLES` full reads. The design's "filter F, default all" seam is satisfied because the copy's read is the single point a future predicate would attach; I did not add an unused filter parameter (YAGNI) — the seam is the `readRows`/`COPY_TABLES` boundary, documented in `copy-engine.ts`. If a reviewer wants the parameter present now, that's a plan-vs-review call for the human.

**2. Placeholder scan:** Task 5 (route wiring of real `buildConvertCopyDeps` against two live pools) and Task 8 (per-card JSX) carry implementer-judgment latitude rather than verbatim code, because both are genuinely environment-dependent (live-pool SQL wiring; design-driven JSX to Figma frames). Each names the exact contract, the functions to reuse, and the fixed behavioral gates — not "TODO." The automated tests pin the logic boundaries; the live SQL path and visual rendering are covered by manual acceptance (below). This is the same deliberate pattern used successfully in the content-moderation plan's registry-wiring task.

**3. Type consistency:** `ProbeResult` shape is identical in Task 2 (server) and Task 7 (client). `ConvertResult` identical in Task 4 (server) and Task 7 (client). `CopyDeps` consistent Tasks 3→4→5. `WizardStep`/`canAdvance` consistent Tasks 6→8. `stampAttribution(metadata, { userId })` matches the Identity Core signature from the Explore map. ✓

**Live acceptance note (for the final whole-branch review):** dogfood a real conversion — stand up a scratch remote Postgres (pgvector), run Test Connection (see the checklist), sign in, run Convert, confirm: local `~/.memsmith/pgdata` byte-unchanged; remote has the observations with `createdByUserId` = the owner; `settings.json` flipped to `server` + the URL; `restartRequired` surfaced; a re-run of migrate does not duplicate; a forced verify mismatch does not flip. Query both PGs via the `pg` module (not embedded psql — dyld bug), local role `memsmith` @ `:55433`.
