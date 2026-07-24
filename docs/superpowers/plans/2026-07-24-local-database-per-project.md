# Local Database-Per-Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each local project connects to its own PostgreSQL database (`msp_<projectId>`) inside the one embedded server; the dogfood keeps its existing `postgres` database untouched. Physical isolation replaces identity-scoping. Fixes finding #3, unblocks P3.

**Architecture:** One seam — `startLocalRuntime` sets `MEMSMITH_SERVER_DATABASE_URL`, and everything downstream reads it. The fix inserts, right after the embedded server boots, a resolver that: reads the project marker → resolves the per-project DB name (marker → back-compat-probe → mint, stamping the marker) → `CREATE DATABASE` if absent → sets `MEMSMITH_SERVER_DATABASE_URL` to the project-scoped URL before import/bootstrap/server-loop. Plus a marker `databaseName` field, a one-time dogfood marker stamp, and deletion of the 1 leaked temp row.

**Tech Stack:** TypeScript, node-postgres (`pg`), embedded Postgres, `bun test`.

## Global Constraints

- Branch from `main` (`ca1ed790`); already on branch `local-database-per-project`. Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Dogfood must never be at risk.** The dogfood stays in its existing `postgres` database, untouched. `CREATE DATABASE` ONLY creates — never drops/alters. The leaked-row delete (Task 4) is scoped to the `a1eafc94` project_id ONLY, backup-first, count-verified. Integration tests use a throwaway data dir + non-`:55433` port and hard-refuse `~/.memsmith`/`:55433`.
- `CREATE DATABASE` cannot run inside a transaction and must run against the `postgres` maintenance database via a dedicated short-lived admin connection (NOT the pooled project connection). Close it after.
- The back-compat probe (`SELECT … FROM observations WHERE project_id=$1`) MUST tolerate a fresh `postgres` DB with no `observations` table (catch → treat as "no rows" → mint). A probe failure must never block boot.
- If DB creation genuinely fails (permissions/disk) → boot fails LOUD; never silently fall back to the shared `postgres` DB (that reintroduces the leak).
- Marker gains only `databaseName` (non-secret). The team API key stays in `CredentialStore`.
- No dependency changes. Per-project DBs use the SAME existing schema via the existing `bootstrapServerPostgresSchema`.

## Existing anchors (verified)

- `startLocalRuntime` (`src/server/runtime/local-runtime.ts:19-40`): `manager.start()` returns the base `postgres` connectionString; line 22 sets `process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString`; then `defaultRunImport` (which bootstraps schema) + `defaultStartService` (server loop).
- `EmbeddedPostgresManager.buildConnectionString` (`:178-180`): hardcodes `/postgres`. Username `memsmith`, password `memsmith-local`, `127.0.0.1:<port>`.
- Marker: `ProjectMarker` interface (`src/services/identity/project-identity.ts:22`) has `runtime?`/`serverUrl?`; `readProjectMarker(cwd)` (`:55`); `writeProjectRuntime(cwd, {...})` (`:62`) is the merge-into-existing-marker writer pattern (throws if no marker; never writes a secret) — mirror it for the databaseName stamp.
- `parsePostgresConfig`/`getPostgresDatabaseUrl` (`src/storage/postgres/config.ts`): read `MEMSMITH_SERVER_DATABASE_URL` into `connectionString`. Setting that env var to the project URL is the whole routing mechanism.
- `bootstrapServerPostgresSchema` (`src/storage/postgres/schema.ts`): idempotent; run it against the project DB.

---

## File Structure

- `src/services/identity/project-identity.ts` — marker gains `databaseName?`; add `writeProjectDatabaseName(cwd, name)` (Task 1).
- `src/server/runtime/EmbeddedPostgresManager.ts` — `buildConnectionString(databaseName?)` + a helper to build an arbitrary-DB URL from the instance's host/port/creds (Task 2).
- `src/server/runtime/resolve-project-database.ts` (NEW) — `resolveProjectDatabaseName` + `ensureDatabaseExists` (Task 2).
- `src/server/runtime/local-runtime.ts` — wire the resolver into the boot flow (Task 3).
- Tests: `tests/server/runtime/project-database.test.ts` (Tasks 1-2), `tests/server/runtime/local-database-per-project-integration.test.ts` (Task 3, opt-in).
- One-time ops: dogfood marker stamp + leaked-row delete (Task 4).

---

## Task 1: Marker `databaseName` field + stamp writer

**Files:**
- Modify: `src/services/identity/project-identity.ts`
- Test: `tests/server/runtime/project-database.test.ts` (new; describe block "marker databaseName")

**Interfaces:**
- Produces: `ProjectMarker.databaseName?: string`; `writeProjectDatabaseName(cwd: string, databaseName: string): void` (merges into an existing marker, throws if none — mirrors `writeProjectRuntime`); `readProjectMarker` preserves `databaseName`.

- [ ] **Step 1: Write the failing test**

Add to `tests/server/runtime/project-database.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readProjectMarker, writeProjectDatabaseName } from '../../../src/services/identity/project-identity.js';

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/runtime/project-database.test.ts`
Expected: FAIL — `writeProjectDatabaseName` not exported; `databaseName` not on the type.

- [ ] **Step 3: Implement**

In `src/services/identity/project-identity.ts`:
1. Add `databaseName?: string;` to the `ProjectMarker` interface (near `runtime?`/`serverUrl?`).
2. Ensure `readProjectMarker` preserves it. Inspect the current `readMarker`/`readProjectMarker` body — if it defensively copies known fields, add `databaseName` with the same guard style (`if (typeof m.databaseName === 'string' && m.databaseName.length > 0) out.databaseName = m.databaseName;`). If it returns the parsed object directly, no change is needed beyond the type.
3. Add the writer, mirroring `writeProjectRuntime`:

```ts
export function writeProjectDatabaseName(cwd: string, databaseName: string): void {
  const existing = readMarker(cwd); // the internal marker read used by writeProjectRuntime
  if (!existing) {
    throw new Error(`writeProjectDatabaseName: no project marker at ${join(cwd, MARKER_RELATIVE_PATH)} — mint identity first`);
  }
  writeMarker(cwd, { ...existing, databaseName });
}
```

(Use the same internal `readMarker`/`writeMarker` helpers `writeProjectRuntime` uses. Never write a key/secret.)

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/server/runtime/project-database.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: exit 0 (ignore editor-only false positives: `bun:test`, `.js` import resolution, `ZodTypeAny`).

```bash
git add src/services/identity/project-identity.ts tests/server/runtime/project-database.test.ts
git commit -m "feat(identity): marker databaseName field + writeProjectDatabaseName stamp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: DB-name resolution + ensure-exists + connection-string helper

**Files:**
- Modify: `src/server/runtime/EmbeddedPostgresManager.ts`
- Create: `src/server/runtime/resolve-project-database.ts`
- Test: `tests/server/runtime/project-database.test.ts` (add describe blocks)

**Interfaces:**
- Consumes: `readProjectMarker`/`writeProjectDatabaseName` (Task 1).
- Produces:
  - `EmbeddedPostgresManager.buildConnectionString(databaseName?: string): string` (default `'postgres'`) — public (was private); still hardcodes host/port/creds, only the DB segment varies.
  - `projectDatabaseName(projectId: string): string` — `'msp_' + projectId.replace(/-/g, '')`.
  - `resolveProjectDatabaseName(deps): Promise<string>` where `deps = { cwd; readMarker: (cwd)=>ProjectMarker|null; writeName: (cwd,name)=>void; probeHasProjectRows: (projectId)=>Promise<boolean> }`. Logic: marker.databaseName ? return it; else if probeHasProjectRows(projectId) → stamp+return 'postgres'; else → stamp+return projectDatabaseName(projectId).
  - `ensureDatabaseExists(adminQuery, name): Promise<void>` where `adminQuery = (text, params?)=>Promise<{rows:any[]}>`. If name === 'postgres' → no-op. Else `SELECT 1 FROM pg_database WHERE datname = $1`; if absent, `CREATE DATABASE "<name>"` (identifier-quoted; name is derived from a UUID so it's safe, but quote it).

- [ ] **Step 1: Write failing tests**

Add to `tests/server/runtime/project-database.test.ts`:

```ts
import { projectDatabaseName, resolveProjectDatabaseName, ensureDatabaseExists } from '../../../src/server/runtime/resolve-project-database.js';
import { EmbeddedPostgresManager } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

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
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/server/runtime/project-database.test.ts`
Expected: FAIL — new module + public method absent.

- [ ] **Step 3: Make `buildConnectionString` public + parameterized**

In `EmbeddedPostgresManager.ts`, change `private buildConnectionString(): string` to:

```ts
buildConnectionString(databaseName: string = 'postgres'): string {
  return `postgres://${this.username}:${this.password}@127.0.0.1:${this.port}/${databaseName}`;
}
```

(All existing internal callers pass no arg → still `/postgres`. No behavior change for them.)

- [ ] **Step 4: Create the resolver module**

Create `src/server/runtime/resolve-project-database.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Per-project database resolution for local mode. Each project gets its own PG
// database inside the one embedded server; the dogfood keeps 'postgres'. See
// docs/superpowers/specs/2026-07-24-local-database-per-project-design.md.
import type { ProjectMarker } from '../../services/identity/project-identity.js';

export function projectDatabaseName(projectId: string): string {
  return 'msp_' + projectId.replace(/-/g, '');
}

export interface ResolveProjectDatabaseDeps {
  cwd: string;
  readMarker: (cwd: string) => ProjectMarker | null;
  writeName: (cwd: string, name: string) => void;
  // True if the legacy `postgres` DB already contains rows for this project
  // (a pre-db-per-project install, e.g. the dogfood).
  probeHasProjectRows: (projectId: string) => Promise<boolean>;
}

export async function resolveProjectDatabaseName(deps: ResolveProjectDatabaseDeps): Promise<string> {
  const marker = deps.readMarker(deps.cwd);
  if (!marker) {
    // No marker → cannot scope; caller should have minted identity first. Fall
    // back to postgres (legacy behavior) rather than crash the boot.
    return 'postgres';
  }
  if (marker.databaseName && marker.databaseName.length > 0) return marker.databaseName;

  const adopt = (await deps.probeHasProjectRows(marker.projectId)) ? 'postgres' : projectDatabaseName(marker.projectId);
  try { deps.writeName(deps.cwd, adopt); } catch { /* stamp best-effort; re-detect next boot */ }
  return adopt;
}

export async function ensureDatabaseExists(
  adminQuery: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  name: string,
): Promise<void> {
  if (name === 'postgres') return;
  const existing = await adminQuery('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (existing.rows.length > 0) return;
  // CREATE DATABASE cannot be parameterized or run in a txn. `name` is derived
  // from a UUID (msp_<hex>), so it is safe; quote the identifier defensively.
  await adminQuery(`CREATE DATABASE "${name}"`);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bun test tests/server/runtime/project-database.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add src/server/runtime/EmbeddedPostgresManager.ts src/server/runtime/resolve-project-database.ts tests/server/runtime/project-database.test.ts
git commit -m "feat(runtime): per-project DB name resolution + ensure-exists + parameterized conn string

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire per-project DB into the local boot flow

**Files:**
- Modify: `src/server/runtime/local-runtime.ts`
- Test: `tests/server/runtime/local-database-per-project-integration.test.ts` (new; opt-in, dogfood-guarded)

**Interfaces:**
- Consumes: `resolveProjectDatabaseName`, `ensureDatabaseExists`, `buildConnectionString` (Task 2); `readProjectMarker`/`writeProjectDatabaseName` (Task 1).

**Wiring:** the production default lives in a `defaultResolveDatabaseUrl(baseConnectionString, cwd)` function; `startLocalRuntime` calls it (or the injected seam) to compute the URL it assigns to `MEMSMITH_SERVER_DATABASE_URL` (replacing the direct assignment at line 22). Default implementation:

```ts
import pg from 'pg';
import { EmbeddedPostgresManager } from './EmbeddedPostgresManager.js';
import { readProjectMarker, writeProjectDatabaseName } from '../../services/identity/project-identity.js';
import { resolveProjectDatabaseName, ensureDatabaseExists } from './resolve-project-database.js';

async function defaultResolveDatabaseUrl(baseConnectionString: string, cwd: string): Promise<string> {
  // baseConnectionString targets `postgres` (the maintenance DB). Use it to
  // resolve the per-project DB, create it if needed, then return the
  // project-scoped URL. Never leaves the runtime on the shared `postgres` DB
  // for a non-legacy project.
  const adminPool = new pg.Pool({ connectionString: baseConnectionString, max: 2 });
  try {
    const dbName = await resolveProjectDatabaseName({
      cwd,
      readMarker: readProjectMarker,
      writeName: writeProjectDatabaseName,
      probeHasProjectRows: async (projectId) => {
        try {
          const r = await adminPool.query('SELECT 1 FROM observations WHERE project_id = $1 LIMIT 1', [projectId]);
          return r.rows.length > 0;
        } catch { return false; } // fresh postgres DB has no observations table yet
      },
    });
    await ensureDatabaseExists((t, p) => adminPool.query(t, p), dbName);
    // Rebuild the URL with the project DB name. Parse the base URL and swap the
    // path segment (host/port/creds unchanged). Simplest: derive from the same
    // pieces via a fresh EmbeddedPostgresManager().buildConnectionString(dbName)
    // ONLY IF port/creds match the base; otherwise string-replace the trailing
    // `/postgres` path of baseConnectionString with `/<dbName>`. Use the URL
    // path-swap (robust, no manager coupling):
    const u = new URL(baseConnectionString);
    u.pathname = '/' + dbName;
    return u.toString();
  } finally {
    await adminPool.end();
  }
}
```

`defaultRunImport` calls `getSharedPostgresPool` which reads `MEMSMITH_SERVER_DATABASE_URL` — so it MUST run AFTER the env var is repointed (it does; the resolve happens at the old line-22 point, before `runImport`).

- [ ] **Step 1: Write the opt-in integration test (isolation proof)**

Create `tests/server/runtime/local-database-per-project-integration.test.ts`. Guard idiom: opt-in via `MEMSMITH_TEST_DBPERPROJ === '1'`; hard dogfood guard (throwaway data dir under `tmpdir()`, port `55451`, assert not `~/.memsmith`/`55433`). Structure:

1. Boot an embedded PG on the throwaway port/dir (reuse the pattern from `local-coldboot-integration.test.ts`: explicit `EmbeddedPostgresManager({ paths:{binariesDir: ~/.memsmith/pg-binaries, dataDir, pidFile}, port })`, `startService` no-op, injected lightweight `runImport` is not needed here — call the manager + resolver directly).
2. Using an admin pool on the base `postgres` URL: `ensureDatabaseExists` for `msp_A` and `msp_B`; bootstrap schema in each; insert 1 observation into `msp_A` (project A), 1 into `msp_B` (project B) with the correct FK rows (teams/projects first, per the schema).
3. **Isolation assertions:** connect to `msp_A` → `SELECT count(*) FROM observations` = 1 and it is A's row; the `msp_B` row's id is ABSENT from `msp_A`. Connect to `msp_B` → sees only B's row. This proves physical isolation (a broken shared model would show both in one DB).
4. **Idempotency:** `ensureDatabaseExists('msp_A')` again → no error, no duplicate DB.
5. Cleanup: drop the throwaway DBs / stop PG / rm temp dir in `afterAll`.

- [ ] **Step 2: Run WITHOUT opt-in → clean skip**

Run: `bun test tests/server/runtime/local-database-per-project-integration.test.ts`
Expected: "Ran 0 tests" (no PG, no crash).

- [ ] **Step 3: (If a throwaway PG is feasible) run WITH opt-in**

Run: `MEMSMITH_TEST_DBPERPROJ=1 bun test tests/server/runtime/local-database-per-project-integration.test.ts`
Expected: PASS (isolation proven). If binaries/port unavailable, report skipped and rely on Task 2 unit tests. NEVER point at `~/.memsmith`/`:55433`.

- [ ] **Step 4: Wire `startLocalRuntime`**

Apply the wiring block above. Import `resolveProjectDatabaseName`/`ensureDatabaseExists` from `./resolve-project-database.js`, `readProjectMarker`/`writeProjectDatabaseName` from `../../services/identity/project-identity.js`, and `pg` (or `createPostgresPool` with the base URL) for the admin pool. Keep the existing import/serve sequence otherwise unchanged.

- [ ] **Step 5: Typecheck + touched suites**

**REQUIRED seam (not optional):** `local-runtime.test.ts:20-22` injects a fake `manager` and asserts `process.env.MEMSMITH_SERVER_DATABASE_URL === conn` (the fake's raw connection string). The new DB-resolution block repoints that env var via a REAL `pg.Pool` against the base URL — which would both break that assertion AND try to open a real pool against a fake string. So you MUST add an injectable seam on `StartLocalRuntimeOptions`, mirroring `startService`/`runImport`:

```ts
// StartLocalRuntimeOptions gains:
resolveDatabaseUrl?: (baseConnectionString: string, cwd: string) => Promise<string>;
```

Default (production): the block from the Task 3 wiring — build admin pool on `baseConnectionString`, resolve project DB name, ensure it exists, return `manager.buildConnectionString(dbName)`. Injected (tests): a passthrough. In `startLocalRuntime`, replace the direct `process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString` (line 22) with:
```ts
const resolveDatabaseUrl = options.resolveDatabaseUrl ?? defaultResolveDatabaseUrl;
process.env.MEMSMITH_SERVER_DATABASE_URL = await resolveDatabaseUrl(connectionString, process.env.MEMSMITH_PROJECT_CWD ?? process.cwd());
```
Then update `local-runtime.test.ts`'s two `startLocalRuntime({...})` calls to inject `resolveDatabaseUrl: async (c) => c` (passthrough) so its `=== conn` assertion still holds and no real pool is opened. This keeps the existing test hermetic AND passing.

Run: `npx tsc --noEmit && bun test tests/server/runtime/project-database.test.ts tests/server/local-runtime.test.ts`
Expected: tsc exit 0; tests PASS (no NEW failures).

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime/local-runtime.ts tests/server/runtime/local-database-per-project-integration.test.ts
git commit -m "feat(runtime): route local boot to the project's own database

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: One-time ops — dogfood marker stamp + leaked-row delete + rebuild/sync

**Files:** none shipped (controller-run one-time ops + bundle rebuild).

**This task is controller-executed (not a subagent), because it touches the LIVE dogfood.** Backup-first, verify-after.

- [ ] **Step 1: Backup the leaked row before deleting**

Query + save the `a1eafc94` row(s) from the live dogfood `postgres` DB to a timestamped `/tmp` file (data-only), so the delete is reversible. Confirm the count of rows to delete (expected 1).

- [ ] **Step 2: Delete the leaked temp row (scoped, verified)**

`DELETE FROM observations WHERE project_id = '<the a1eafc94 full projectId>'` on the dogfood `postgres` DB. Assert: rows deleted === the backed-up count; the dogfood's OWN project (`5fc024f0`) count is unchanged (its true count, ~4103). Do the same for any other tables that carry that project_id if present (agent_events/server_sessions/jobs) — check first; the leak was 1 observation so likely none.

- [ ] **Step 3: Stamp the dogfood marker**

Set `databaseName: "postgres"` in `/Users/shwaits/Workspace/team-agent-memory/.memsmith/project.json` (merge, preserve existing fields). This pins the dogfood to its existing DB explicitly.

- [ ] **Step 4: Rebuild + sync the bundle**

`npm run build-and-sync` (file-sync only; must not disrupt the running dogfood — verify `:38879` health before/after). Confirm the shipped `server-service.cjs` contains the new resolver (grep `resolve-project-database` symbols or `msp_`).

- [ ] **Step 5: Commit the rebuilt bundle**

Stage only `plugin/scripts/*.cjs` that legitimately changed.

```bash
git add plugin/scripts/server-service.cjs   # + others if co-rebuilt
git commit -m "chore(build): rebuild bundle with per-project database routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** D1 naming → Task 2 `projectDatabaseName`. D2 dogfood-pinned/back-compat → Task 2 `resolveProjectDatabaseName` + Task 1 marker + Task 4 stamp. D3 boot flow → Task 3. D4 stamp → Task 4 Step 3. D5 cleanup → Task 4 Steps 1-2. Testing #1-3 (unit) → Tasks 1-2. #4 (integration isolation) → Task 3. #6 (ops verify) → Task 4.
- **Placeholder scan:** the resolver/ensure/marker code is complete. The Task 3 wiring shows the exact block with a called-out testability seam (`resolveDatabase` injectable) so `local-runtime.test.ts` stays hermetic — a real instruction, not a placeholder. The admin-pool construction is described precisely (dedicated `pg.Pool` on the base URL, closed in `finally`).
- **Type consistency:** `resolveProjectDatabaseName(deps)` / `ensureDatabaseExists(adminQuery, name)` / `projectDatabaseName(projectId)` / `buildConnectionString(databaseName?)` / `writeProjectDatabaseName(cwd, name)` names identical across code, tests, and wiring. `ProjectMarker.databaseName?` used consistently.
- **Dogfood safety:** Task 4 is controller-run, backup-first, scoped delete, count-verified; `CREATE DATABASE` only-creates; integration test throwaway + guarded. The dogfood's `postgres` DB is never dropped/altered/moved.
