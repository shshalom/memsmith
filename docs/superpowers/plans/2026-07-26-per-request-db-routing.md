# Per-Request Database Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server process (one port, one shared embedding model) routes each request to the correct project's database, so a SECOND concurrent local project is physically isolated instead of riding the first project's database.

**Architecture:** A `PoolRegistry` (`Map<dbName, Pool>`, single-flight, provisions on first touch) plus a `resolveRequestDatabase` middleware that sets `req.databasePool` from **`authContext.projectId` only**. Account tables (`api_keys`, `team_members`, `usage_events`, `audit_log`, `rate_limit_counters`, `server_settings`) live in the base database; project-data tables live per-project DB; `teams`+`projects` are replicated into each project DB as an FK anchor ("hinge").

**Tech Stack:** TypeScript, node-postgres (`pg`), Express, embedded Postgres, `bun test`.

## Global Constraints

- Branch from `main` (`d31e98f3`); already on branch `per-request-db-routing`. Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **SECURITY INVARIANT (the review focus):** the database a request touches is derived from `req.authContext.projectId` and **nothing else**. A client-supplied `projectId` (query param or body) may narrow a `WHERE` clause but must NEVER select a pool. Any code that picks a pool from `req.query`/`req.body` is a Critical defect.
- **Dogfood never at risk.** The dogfood is the cold-boot/base project and keeps its existing database. No `DROP`/`ALTER` of any existing database. Provisioning only ever `CREATE`s new databases. Integration tests use a throwaway data dir + non-`:55433` port and hard-refuse `~/.memsmith`/`:55433`.
- The schema split must NOT run a destructive migration. The base DB already has every table; splitting only changes what a **new** database gets.
- No new dependencies. `bun test` is the runner; `npx tsc --noEmit` (CLI) is the typecheck gate — ignore editor-only false positives (`bun:test` module, `.js` import resolution, `ZodTypeAny` deprecated).
- 5 pre-existing `tests/server/` failures are environmental `ECONNREFUSED` (no live PG). "No NEW failures" is the bar.

## Verified anchors

- `PHASE_1_SCHEMA_SQL` = `schema.ts:162-439`; applied by `applyPhase1Migration` inside `BEGIN/COMMIT`, after a non-transactional `CREATE EXTENSION IF NOT EXISTS vector` (`schema.ts:29-56`).
- Table start lines: `server_beta_schema_migrations`:163, `teams`:169, `projects`:177, `team_members`:187, `api_keys`:197, `audit_log`:212, `server_sessions`:227, `agent_events`:247, `observation_generation_jobs`:266, `observations`:301, `observation_sources`:318, `observation_generation_job_events`:336, `usage_events`:397, `rate_limit_counters`:410. (`server_settings` is created separately near line 93.)
- Indexes/ALTERs live at `schema.ts:346-407` and must be classified with their table.
- `this.options.pool` appears **52** times in `ServerV1PostgresRoutes.ts`; account middleware use it at `:202,209,223,225,226,231,1341,1348,1386`.
- Dashboard holds `options.db` (`dashboard/routes.ts:163,170`); `buildScope` is `:132-140`.
- Single pool construction: `create-server-service.ts:194`.
- `ensureDatabaseExists` + `projectDatabaseName` already exist in `src/server/runtime/resolve-project-database.ts` (from d31e98f3) — REUSE, do not reimplement.
- No SQL joins cross the account/data boundary (only `teams ⋈ team_members`, `teams.ts:90` — both account-side).

## Table classification (authoritative for Tasks 1 & 4)

| Class | Tables |
|---|---|
| **ACCOUNT** (base DB only) | `api_keys`, `team_members`, `usage_events`, `audit_log`, `rate_limit_counters`, `server_settings` |
| **PROJECT DATA** (each `msp_` DB) | `observations`, `observation_sources`, `agent_events`, `server_sessions`, `observation_generation_jobs`, `observation_generation_job_events` |
| **HINGE** (BOTH) | `teams`, `projects`, `server_beta_schema_migrations` |

---

## Task 1: Split the schema into account / project / hinge

**Files:**
- Modify: `src/storage/postgres/schema.ts`
- Test: `tests/storage/postgres/schema-split.test.ts` (new)

**Interfaces:**
- Produces: `bootstrapServerPostgresSchema(client, mode?: 'full' | 'account' | 'project')` — `'full'` is the DEFAULT and produces today's exact behavior (all tables), so every existing caller is unchanged. `'account'` = ACCOUNT + HINGE. `'project'` = PROJECT DATA + HINGE.
- Also exports the three SQL constants for testing: `ACCOUNT_SCHEMA_SQL`, `PROJECT_SCHEMA_SQL`, `HINGE_SCHEMA_SQL`.

**Design note (why `'full'` stays the default):** the base/dogfood DB must keep getting every table, and every current caller (cold boot, tests, convert bootstrap) relies on that. Only the new per-project provisioning path (Task 3) passes `'project'`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/postgres/schema-split.test.ts`. Test the SQL constants directly (string assertions — no DB needed), so this task is hermetic:

```ts
import { describe, it, expect } from 'bun:test';
import { ACCOUNT_SCHEMA_SQL, PROJECT_SCHEMA_SQL, HINGE_SCHEMA_SQL } from '../../../src/storage/postgres/schema.js';

const ACCOUNT = ['api_keys', 'team_members', 'usage_events', 'audit_log', 'rate_limit_counters'];
const DATA = ['observations', 'observation_sources', 'agent_events', 'server_sessions', 'observation_generation_jobs', 'observation_generation_job_events'];
const HINGE = ['teams', 'projects', 'server_beta_schema_migrations'];

const creates = (sql: string) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(m => m[1]);

describe('schema split', () => {
  it('hinge SQL creates exactly the hinge tables', () => {
    expect(creates(HINGE_SCHEMA_SQL).sort()).toEqual([...HINGE].sort());
  });
  it('account SQL creates account tables and NO data tables', () => {
    const t = creates(ACCOUNT_SCHEMA_SQL);
    for (const a of ACCOUNT) expect(t).toContain(a);
    for (const d of DATA) expect(t).not.toContain(d);
  });
  it('project SQL creates data tables and NO account tables', () => {
    const t = creates(PROJECT_SCHEMA_SQL);
    for (const d of DATA) expect(t).toContain(d);
    for (const a of ACCOUNT) expect(t).not.toContain(a);
  });
  it('every data table keeps its projects/teams FK (hinge anchor preserved)', () => {
    // The composite FK to projects(id, team_id) must survive the split.
    expect(PROJECT_SCHEMA_SQL).toContain('REFERENCES projects(id, team_id)');
    expect(PROJECT_SCHEMA_SQL).toContain('REFERENCES teams(id)');
  });
  it('no CREATE TABLE is lost: full = hinge + account + project (union)', () => {
    const union = new Set([...creates(HINGE_SCHEMA_SQL), ...creates(ACCOUNT_SCHEMA_SQL), ...creates(PROJECT_SCHEMA_SQL)]);
    for (const t of [...ACCOUNT, ...DATA, ...HINGE]) expect(union.has(t)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/storage/postgres/schema-split.test.ts`
Expected: FAIL — the three constants are not exported.

- [ ] **Step 3: Perform the split**

In `src/storage/postgres/schema.ts`, replace the single `PHASE_1_SCHEMA_SQL` (lines 162-439) with three exported constants, moving each `CREATE TABLE` **together with its own indexes/ALTERs** (from the `:346-407` block) into the matching constant:

- `HINGE_SCHEMA_SQL`: `server_beta_schema_migrations` (163), `teams` (169), `projects` (177), plus `idx_projects_team` (381).
- `ACCOUNT_SCHEMA_SQL`: `team_members` (187), `api_keys` (197), `audit_log` (212), `usage_events` (397), `rate_limit_counters` (410), plus `idx_audit_log_scope_created` (393) and the `idx_usage_events_*` indexes (406-407). Also include the `server_settings` DDL (near line 93) if it is part of the same bootstrap path — check and keep its current placement semantics.
- `PROJECT_SCHEMA_SQL`: `server_sessions` (227), `agent_events` (247), `observation_generation_jobs` (266), `observations` (301), `observation_sources` (318), `observation_generation_job_events` (336), plus ALL of their indexes/ALTERs in `346-392` (the `agent_events`, `server_sessions`, `observations`, `observation_*` ones — everything in that block except the `projects`, `audit_log`, and `usage_events` entries).

Then define composition + the mode parameter:

```ts
// Back-compat: 'full' reproduces the pre-split single schema exactly.
const PHASE_1_SCHEMA_SQL = `${HINGE_SCHEMA_SQL}\n${ACCOUNT_SCHEMA_SQL}\n${PROJECT_SCHEMA_SQL}`;

export type SchemaMode = 'full' | 'account' | 'project';

function schemaSqlFor(mode: SchemaMode): string {
  if (mode === 'account') return `${HINGE_SCHEMA_SQL}\n${ACCOUNT_SCHEMA_SQL}`;
  if (mode === 'project') return `${HINGE_SCHEMA_SQL}\n${PROJECT_SCHEMA_SQL}`;
  return PHASE_1_SCHEMA_SQL;
}
```

Thread `mode` through `bootstrapServerPostgresSchema(client, mode: SchemaMode = 'full')` → `applyPhase1Migration(client, mode)` → `client.query(schemaSqlFor(mode))`. Keep the `CREATE EXTENSION` + `BEGIN/COMMIT` structure exactly as-is (extension outside the txn).

**ORDERING CONSTRAINT:** within each constant, `CREATE TABLE`s must still precede the indexes/ALTERs that reference them, and hinge tables must come first (data tables FK them). The composed `'full'` string must keep the original relative order: hinge → account → project. Verify by diffing the composed `'full'` output against the original constant if practical.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/storage/postgres/schema-split.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Regression — existing schema tests still green**

Run: `npx tsc --noEmit && bun test tests/storage/postgres/`
Expected: tsc exit 0; no NEW failures (PG-gated tests may skip). The `'full'` default means every existing bootstrap behaves identically.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres/schema.ts tests/storage/postgres/schema-split.test.ts
git commit -m "refactor(schema): split into hinge/account/project SQL with a mode parameter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: PoolRegistry

**Files:**
- Create: `src/storage/postgres/pool-registry.ts`
- Test: `tests/storage/postgres/pool-registry.test.ts` (new)

**Interfaces:**
- Consumes: `ensureDatabaseExists` (`resolve-project-database.ts`), `bootstrapServerPostgresSchema(client,'project')` (Task 1).
- Produces:
  ```ts
  export interface PoolRegistryDeps {
    baseConnectionString: string;
    basePool: PostgresPool;              // the cold-boot/base DB pool
    baseDatabaseName: string;            // e.g. 'postgres'
    createPool: (connectionString: string) => PostgresPool;
    adminQuery: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    bootstrapProject: (pool: PostgresPool) => Promise<void>;
    seedHinge: (pool: PostgresPool, ids: { teamId: string; projectId: string }) => Promise<void>;
  }
  export class PoolRegistry {
    constructor(deps: PoolRegistryDeps);
    getPool(databaseName: string, ids: { teamId: string; projectId: string }): Promise<PostgresPool>;
    closeAll(): Promise<void>;
  }
  ```
- Behavior: `databaseName === baseDatabaseName` → return `basePool` (no provisioning). Otherwise return the cached pool, or **single-flight** create: `ensureDatabaseExists` → `createPool(url with swapped path)` → `bootstrapProject` → `seedHinge` → cache. On failure, do NOT cache; the in-flight promise is evicted so the next request retries.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/postgres/pool-registry.test.ts` with injected fakes (no real PG):

```ts
import { describe, it, expect } from 'bun:test';
import { PoolRegistry } from '../../../src/storage/postgres/pool-registry.js';

function makeDeps(overrides: Partial<any> = {}) {
  const calls = { created: [] as string[], bootstrapped: 0, seeded: 0, admin: [] as string[] };
  const basePool = { __base: true } as any;
  const deps: any = {
    baseConnectionString: 'postgres://u:p@127.0.0.1:55433/postgres',
    basePool,
    baseDatabaseName: 'postgres',
    createPool: (cs: string) => { calls.created.push(cs); return { __cs: cs } as any; },
    adminQuery: async (t: string) => { calls.admin.push(t); return { rows: [] }; },
    bootstrapProject: async () => { calls.bootstrapped += 1; },
    seedHinge: async () => { calls.seeded += 1; },
    ...overrides,
  };
  return { deps, calls, basePool };
}
const IDS = { teamId: 't1', projectId: 'p1' };

describe('PoolRegistry', () => {
  it('returns the base pool for the base database without provisioning', async () => {
    const { deps, calls, basePool } = makeDeps();
    const r = new PoolRegistry(deps);
    expect(await r.getPool('postgres', IDS)).toBe(basePool);
    expect(calls.created).toEqual([]);
    expect(calls.bootstrapped).toBe(0);
  });

  it('provisions once then caches', async () => {
    const { deps, calls } = makeDeps();
    const r = new PoolRegistry(deps);
    const a = await r.getPool('msp_x', IDS);
    const b = await r.getPool('msp_x', IDS);
    expect(a).toBe(b);
    expect(calls.created).toHaveLength(1);
    expect(calls.bootstrapped).toBe(1);
    expect(calls.seeded).toBe(1);
  });

  it('builds the URL by swapping only the database path', async () => {
    const { deps, calls } = makeDeps();
    await new PoolRegistry(deps).getPool('msp_x', IDS);
    expect(calls.created[0]).toBe('postgres://u:p@127.0.0.1:55433/msp_x');
  });

  it('is single-flight: concurrent getPool creates one pool', async () => {
    const { deps, calls } = makeDeps();
    const r = new PoolRegistry(deps);
    const [a, b] = await Promise.all([r.getPool('msp_y', IDS), r.getPool('msp_y', IDS)]);
    expect(a).toBe(b);
    expect(calls.created).toHaveLength(1);
    expect(calls.bootstrapped).toBe(1);
  });

  it('does not cache a failed provision; a later call retries', async () => {
    let fail = true;
    const { deps, calls } = makeDeps({ bootstrapProject: async () => { if (fail) throw new Error('boom'); calls.bootstrapped += 1; } });
    const r = new PoolRegistry(deps);
    await expect(r.getPool('msp_z', IDS)).rejects.toThrow('boom');
    fail = false;
    await r.getPool('msp_z', IDS);           // retry succeeds
    expect(calls.created).toHaveLength(2);   // re-attempted, not served from cache
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/storage/postgres/pool-registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/storage/postgres/pool-registry.ts` implementing the interface above. Single-flight = cache the **promise** (`Map<string, Promise<Pool>>`), and on rejection `delete` the entry inside a `.catch` so a retry re-attempts. URL: `const u = new URL(base); u.pathname = '/' + databaseName; u.toString()`. `closeAll()` ends every created pool (NOT `basePool` — the server owns that).

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/storage/postgres/pool-registry.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add src/storage/postgres/pool-registry.ts tests/storage/postgres/pool-registry.test.ts
git commit -m "feat(storage): PoolRegistry with single-flight per-database provisioning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Local-dev bypass carries the request's projectId

**Files:**
- Modify: `src/server/middleware/postgres-auth.ts`
- Test: `tests/server/middleware/local-dev-project-routing.test.ts` (new)

**Interfaces:**
- Produces: in `local-dev` bypass mode ONLY, `authContext.projectId` = the request's own `projectId` (`req.body?.projectId` ?? `req.query?.projectId`, trimmed, string) when present, else `options.localDevProjectId`. `teamId` keeps its current behavior (`options.localDevTeamId`). **api-key mode is untouched** — its `projectId` continues to come from the `api_keys` row (`postgres-auth.ts:316`).

**Why this is safe (state in the code comment):** this branch is reachable only on the loopback local-dev bypass — a single-user machine boundary, not multi-tenant. It makes `authContext` the ONE routing source for every mode (Task 4), instead of routes reading raw request fields.

- [ ] **Step 1: Write the failing test**

Create `tests/server/middleware/local-dev-project-routing.test.ts`. Mirror the structure of the existing `tests/server/local-dev-team-scope.test.ts` (read it first for the established fake-req/res + bypass-options idiom). Cases:
1. local-dev bypass + `req.body.projectId = 'p-req'` → `authContext.projectId === 'p-req'`.
2. local-dev bypass + no request projectId → `authContext.projectId === localDevProjectId`.
3. local-dev bypass + `req.query.projectId = 'p-q'` (no body) → `'p-q'`.
4. **api-key mode + `req.body.projectId = 'attacker'`** → `authContext.projectId` is the KEY's project, NOT `'attacker'` (the security guard).

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/server/middleware/local-dev-project-routing.test.ts`
Expected: FAIL — bypass currently always uses `localDevProjectId`.

- [ ] **Step 3: Implement**

In `postgres-auth.ts`, in the local-dev bypass branch (~line 157, where `projectId: options.localDevProjectId ?? null` is set), read the request-supplied projectId first:

```ts
// local-dev bypass ONLY: take the project from the request so a SECOND local
// project on the shared server routes to its own database. Safe because this
// branch is loopback + local-dev (single-user machine), never multi-tenant.
// api-key mode below is unaffected: its projectId comes from the api_keys row.
const requestProjectId =
  (typeof (req as any).body?.projectId === 'string' && (req as any).body.projectId.trim())
  || (typeof (req as any).query?.projectId === 'string' && (req as any).query.projectId.trim())
  || '';
```
then `projectId: requestProjectId || options.localDevProjectId || null`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/server/middleware/local-dev-project-routing.test.ts`
Expected: PASS (4 cases, including the api-key guard).

- [ ] **Step 5: Regression + typecheck + commit**

Run: `npx tsc --noEmit && bun test tests/server/local-dev-team-scope.test.ts tests/server/middleware/`
Expected: tsc 0; no NEW failures.

```bash
git add src/server/middleware/postgres-auth.ts tests/server/middleware/local-dev-project-routing.test.ts
git commit -m "feat(auth): local-dev bypass adopts the request's projectId for routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: resolveRequestDatabase middleware

**Files:**
- Create: `src/server/middleware/resolve-request-database.ts`
- Modify: the Express request typing (wherever `authContext?: AuthContext` is declared — `postgres-auth.ts:77`) to add `databasePool?: PostgresPool`
- Test: `tests/server/middleware/resolve-request-database.test.ts` (new)

**Interfaces:**
- Produces: `resolveRequestDatabase(registry: PoolRegistry, opts: { baseDatabaseName: string }): RequestHandler`.
- Behavior: read `req.authContext.projectId` + `teamId`. If no projectId → `400 { error: 'no project identity' }` (do NOT fall through to the base DB). Else `databaseName = projectDatabaseName(projectId)` UNLESS the project is the base/cold-boot project — see below. Set `req.databasePool = await registry.getPool(databaseName, { teamId, projectId })`. On provisioning error → `500`.
- **Base-project detection:** the cold-boot project (the dogfood) lives in the base database, not `msp_<id>`. Resolve via the same marker-aware helper used at boot: if `resolveProjectDatabaseName`-style resolution says this project's database is the base name, use it. Simplest correct rule for this task: the server records, at construction, the cold-boot project's `{ projectId, databaseName }`; the middleware maps that projectId → that databaseName; every other projectId → `projectDatabaseName(projectId)`. Pass that mapping in `opts`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/middleware/resolve-request-database.test.ts` with a fake registry:

```ts
// cases:
// 1. authContext.projectId = base project id → req.databasePool === base pool; registry got the base name
// 2. authContext.projectId = 'p2' → registry got projectDatabaseName('p2'); req.databasePool set
// 3. NO authContext.projectId → 400, next() NOT called, registry NOT consulted
// 4. SECURITY: authContext.projectId='A' but req.query.projectId='B' and req.body.projectId='B'
//    → registry is asked for A's database. (This is the Critical regression guard.)
// 5. registry.getPool rejects → 500, next() not called with a pool
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/server/middleware/resolve-request-database.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create the middleware per the interface. It must read ONLY `req.authContext` for routing — never `req.query`/`req.body`. Add a file-top comment stating that invariant.

- [ ] **Step 4: Run to verify pass; typecheck; commit**

Run: `bun test tests/server/middleware/resolve-request-database.test.ts && npx tsc --noEmit`
Expected: PASS (5 cases); tsc 0.

```bash
git add src/server/middleware/resolve-request-database.ts src/server/middleware/postgres-auth.ts tests/server/middleware/resolve-request-database.test.ts
git commit -m "feat(server): resolveRequestDatabase middleware (routes by authContext only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire the registry + middleware; re-point data routes

**Files:**
- Modify: `src/server/runtime/create-server-service.ts` (construct registry, pass down, close on stop)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (classify 52 pool uses; mount middleware after auth)
- Modify: `src/server/dashboard/routes.ts` (pool from authContext via registry; `buildScope` filtering unchanged)
- Modify: `src/cli/handlers/session-init.ts` (mint identity/keys against the BASE pool explicitly)
- Test: extend existing V1/dashboard tests as needed

**Classification rule (apply per call site):**
- Touches ACCOUNT tables (`api_keys`, `team_members`, `usage_events`, `audit_log`, `rate_limit_counters`, `server_settings`) → keep `this.options.pool` (base).
- Touches PROJECT DATA (`observations`, `agent_events`, `server_sessions`, `observation_generation_jobs`, `observation_sources`, `observation_generation_job_events`) → use `req.databasePool`.
- Auth/rate-limit/quota/metering middleware (`:202,209,223,225,226,231,1341,1348,1386`) → base pool (they run BEFORE routing and read account tables).
- `teams`/`projects` reads: base pool (authoritative copy) unless the query is joined to project data in the same statement — per the verified finding, none are.

- [ ] **Step 1: Construct the registry**

In `create-server-service.ts` (after the pool at `:194`): build the `PoolRegistry` with `basePool = pool`, `baseDatabaseName` parsed from the connection URL's pathname, `bootstrapProject: (p) => bootstrapServerPostgresSchema(p, 'project')`, `seedHinge` inserting the `teams`/`projects` rows (mirror `local-runtime.ts:85-89`), `adminQuery` on a maintenance connection. Pass the registry (and the cold-boot `{projectId, databaseName}` mapping) into the V1 routes + dashboard options. Call `registry.closeAll()` in the service `stop()` path.

- [ ] **Step 2: Mount the middleware after auth**

In `ServerV1PostgresRoutes`, add `resolveRequestDatabase(registry, opts)` to the guard chains so it runs AFTER the auth middleware that sets `authContext` and BEFORE data handlers.

- [ ] **Step 3: Re-point data-route pool uses**

Walk the 52 `this.options.pool` sites and apply the classification rule. Handlers that need the per-request pool take it from `req.databasePool`. Where a repository is constructed with a pool inside a handler (e.g. `new PostgresObservationRepository(this.options.pool)`), construct it with `req.databasePool` instead.

- [ ] **Step 4: Dashboard**

`buildScope` stays exactly as-is (filtering). The dashboard's data queries take a pool resolved from `req.authContext.projectId` via the registry (same middleware). `readAuth` keeps using the base pool (`options.db`) since it reads `api_keys`.

- [ ] **Step 5: session-init mints against the base pool**

`session-init.ts:110-117` currently uses `getSharedPostgresPool()`. Since `api_keys` now lives in the base DB only, make the target explicit (base pool / base connection), so key minting cannot land in a project DB.

- [ ] **Step 6: Full gate**

Run: `npx tsc --noEmit && bun test tests/server/ tests/storage/`
Expected: tsc 0; no NEW failures vs the 5 known environmental ones.

- [ ] **Step 7: Commit**

```bash
git add -A src/server src/cli/handlers/session-init.ts tests
git commit -m "feat(server): route data queries per-request; account queries stay on the base pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Two-project isolation integration test (opt-in, dogfood-guarded)

**Files:**
- Test: `tests/server/runtime/per-request-isolation-integration.test.ts` (new)

**Dogfood guard (mandatory):** opt-in via `MEMSMITH_TEST_REQROUTE === '1'`; throwaway data dir under `os.tmpdir()`; PG port `55452`; hard-throw at module load if the data dir contains `/.memsmith` or the port is `55433`. Mirror `tests/server/runtime/local-database-per-project-integration.test.ts`.

- [ ] **Step 1: Write the test**

Boot a throwaway embedded PG + a real server instance against it. Then, through the **HTTP surface** (not direct pools), issue writes as two different authenticated projects (A and B) and assert:
1. A's observation is readable by A and **absent** for B, and vice-versa (cross-project invisibility on ONE running server — the exact P3 gap).
2. Two distinct `msp_` databases exist after the run.
3. A request with `authContext` = A but `?projectId=B` reads **A's** database (Critical regression guard at the integration level).
4. Provisioning is idempotent (second request for A does not re-create).

- [ ] **Step 2: Skip path**

Run without opt-in → "Ran 0 tests" (nothing spun).

- [ ] **Step 3: Opt-in run (only if safe)**

Run: `MEMSMITH_TEST_REQROUTE=1 bun test tests/server/runtime/per-request-isolation-integration.test.ts`
If binaries/port unavailable or ANY doubt about isolation, report skipped and rely on the unit tests. NEVER point at `~/.memsmith`/`:55433`.

- [ ] **Step 4: Typecheck + commit**

```bash
git add tests/server/runtime/per-request-isolation-integration.test.ts
git commit -m "test(server): two-project per-request isolation proof (opt-in, dogfood-guarded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Rebuild + sync the marketplace bundle

**Files:** none shipped (build artifact).

- [ ] **Step 1:** Verify dogfood health (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:38879/api/health`).
- [ ] **Step 2:** `npm run build-and-sync` (file sync only; must not disturb the running dogfood). Re-check health after.
- [ ] **Step 3:** Confirm the shipped bundle carries the new code (grep for `resolveRequestDatabase` / `PoolRegistry` in `~/.claude/plugins/marketplaces/shshalom/plugin/scripts/server-service.cjs`).
- [ ] **Step 4:** Commit only the intentionally-rebuilt `plugin/scripts/*.cjs`.

---

## Self-Review

- **Spec coverage:** D1 registry → Task 2. D2 authContext-only routing → Tasks 3+4. D3 dashboard filter-vs-route → Task 5 Step 4 + Task 4 case 4. D4 schema split + hinge → Task 1. D5 first-touch provisioning → Task 2 (+ Task 5 Step 1 wiring). D6 data/account pool classification + session-init key home → Task 5. D7 first-request identity (verified) → Task 4's 400 path. D8 reuse path unchanged → no task needed. Testing 1-7 → Tasks 1,2,3,4,6.
- **Placeholder scan:** none. Task 5 is deliberately step-wise rather than line-by-line for 52 sites — it carries an explicit *classification rule* plus the verified account-middleware line numbers, which is the actionable form for a mechanical sweep.
- **Type consistency:** `PoolRegistry.getPool(databaseName, ids)`, `PoolRegistryDeps`, `SchemaMode`, `resolveRequestDatabase(registry, opts)`, `req.databasePool` are used identically across tasks and tests.
- **Security:** the Critical invariant is guarded at three levels — unit (Task 3 case 4: api-key ignores body projectId; Task 4 case 4: query/body ignored for routing) and integration (Task 6 case 3). That redundancy is intentional.
- **Risk order:** Task 1 (schema split) is the riskiest and comes first while context is freshest; it is hermetic (string assertions, no DB) and back-compat by default (`'full'`).
