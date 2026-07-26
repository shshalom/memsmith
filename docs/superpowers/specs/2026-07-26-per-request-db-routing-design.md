# Per-Request Database Routing — Design (Option A)

**Date:** 2026-07-26 (revised after code-verified review)
**Status:** Approved (design). Ready for implementation planning.
**Severity:** High — completes local database-per-project (d31e98f3), which does not isolate a
SECOND concurrent project on a shared server. Unblocks P3 and true multi-project-per-machine.

> **Revision note.** The first draft of this spec contained a Critical flaw (the dashboard's
> unauthenticated `?projectId=` query param would have selected the *database*) and two Important
> gaps (undesigned account-table topology; an unverified assumption about identity minting). All
> three are resolved below in D2/D3, D4, and D7 respectively. Claim corrections: `this.options.pool`
> appears **52** times in the V1 routes (not "~54"); the dashboard does hold a pool
> (`options.db`, `routes.ts:163,170`).

## Problem

`local-database-per-project` (d31e98f3) gives each project its own PG database, but resolves the
database ONLY at cold boot (`startLocalRuntime`). A single server PROCESS binds ONE database
connection (`MEMSMITH_SERVER_DATABASE_URL`, set once → one global pool threaded into every route).
So when a SECOND project's session starts while the embedded server is already running, `start`
hits the `reuse` path and returns without per-project resolution — the second project silently
rides the FIRST project's database (the dogfood's `postgres`). Observed in P3: a fresh temp project
minted no marker, created no `msp_` DB, dashboard showed no data, and its agent reported "memory
backend isn't configured."

Root truth: "one PG server, many databases" is incompatible with a server process pinned to a
single database. The database must be chosen **per request**, not once per process.

## Goal

One server process, one port, one boot, **one shared embedding model** — serving unlimited local
projects, each physically isolated in its own database, by routing each request to the correct
project's database pool based on the request's **authenticated** identity. The dogfood keeps its
existing database, untouched.

## Key enabling facts (code-verified)

- The embedding model is already a **module-level singleton** (`embedder.ts`: `let extractorPromise`
  loads once). One model already serves the whole process — sharing it across projects is free. The
  "N models" cost applies only to Option B (N processes).
- **MCP needs no change** — `mcp-server.ts` holds no pool; it is a separate process talking HTTP via
  `ServerClient`. Server-side routing covers it.
- The server is built around ONE injected pool (`create-server-service.ts:194`), threaded into V1
  routes (`this.options.pool`, **52** uses), the dashboard (`options.db`), auth, rate-limit, quota,
  metering.
- **No SQL joins cross the account/data boundary.** The only join touching account tables is
  `teams ⋈ team_members` (`teams.ts:90`) — both stay on the account side. So a schema split requires
  **no query-body rewrites**, only re-pointing which pool executes them.
- **A request can never arrive without a minted identity.** `buildServerContext`
  (`runtime-selector.ts:129-136`) returns `null` — no request is sent — unless BOTH a key (resolved
  from the marker's teamId via `CredentialStore`) and a `projectId` are present.

## Approach

Introduce a **pool registry** (`Map<databaseName, Pool>`, get-or-create + cached) and a
**per-request DB-resolution middleware** (after auth) that sets `req.databasePool` for the request's
**authenticated** project. Data routes use `req.databasePool`; account routes/middleware keep using
the base pool. The Express app, embedding model, and generation logic stay shared and singular.

## Decisions

### D1 — Pool registry
A process-level `PoolRegistry`: `getPool(databaseName): Promise<Pool>` — returns the cached pool, or
creates it (URL built by swapping the DB segment of the base URL: `new URL(base); u.pathname='/'+dbName`),
provisioning on first create (D5). Must be **single-flight**: concurrent `getPool` for the same name
resolves one creation, not N. The base/cold-boot database is a normal registry entry. The registry
owns pool lifecycle (all pools closed on server stop).

### D2 — Routing key is the AUTHENTICATED identity only (Critical fix)
`databaseName` is derived **exclusively** from `req.authContext.projectId`:

- **api-key / team mode:** `authContext.projectId` comes from the authenticated `api_keys` row. A
  request-supplied `projectId` (query param or body) is **NEVER** used to select the database.
- **local-dev loopback bypass:** the bypass currently stamps a boot-time constant
  `localDevProjectId`, which is the second-project bug. Fix: in local-dev mode ONLY, the bypass
  populates `authContext.projectId` from the request's own `projectId` (the client always sends one
  — see Key enabling facts), falling back to `localDevProjectId` when absent. The value therefore
  still enters routing **through `authContext`**, and only on the loopback, single-user-machine
  path. This keeps exactly one routing source for all modes.

**Invariant (review focus):** nothing outside `authContext` may influence which database a request
touches. Client-supplied `projectId` may narrow a `WHERE` clause; it may never choose a pool.

### D3 — Dashboard scope vs routing (Critical fix)
`buildScope` (`dashboard/routes.ts:132-140`) lets a query param **override** `authContext` with no
ownership check ("explicit query param always wins"). That override is retained **for filtering
only** — it continues to shape `WHERE team_id/project_id = …` — but the **pool** is resolved from
`authContext.projectId` per D2. A caller cannot reach another database by passing `?projectId=`.
(Pre-existing authz looseness of the filter override is out of scope here and noted as a follow-up.)

### D4 — Account / project schema split, with hinge replication (Important fix)
`PHASE_1_SCHEMA_SQL` currently creates all 15 tables in every database. Split it:

**ACCOUNT tables — base database only** (~30 query sites):
`api_keys`, `team_members`, `usage_events`, `audit_log`, `rate_limit_counters`, `server_settings`.

**PROJECT-DATA tables — each `msp_` database** (~94 query sites):
`observations`, `observation_sources`, `agent_events`, `server_sessions`,
`observation_generation_jobs`, `observation_generation_job_events`.

**HINGE — `teams` + `projects` exist in BOTH.** Every data table carries a composite FK to
`projects(id, team_id)` (`schema.ts:244,263,297-298,315`) and most also FK `teams(id)`. Postgres
cannot enforce FKs across databases, so each project DB keeps local `teams`/`projects` tables holding
**just its own one team row + one project row** as an FK anchor. This is nearly free: the boot path
already seeds exactly those rows (`local-runtime.ts:85-89`). The base copies remain authoritative for
account purposes.

Rejected alternative: dropping the FKs from data tables — that loses referential integrity on the
core data and requires a destructive `ALTER … DROP CONSTRAINT` migration against the dogfood's live
database. Not worth it.

Both schemas track their own migration state (`server_beta_schema_migrations` exists in each).
`bootstrapServerPostgresSchema` gains a mode (`'account' | 'project'`), defaulting to today's
full-schema behavior for back-compat where needed.

### D5 — First-touch provisioning (fixes the reuse-path gap)
On a registry cache miss the registry: (1) `ensureDatabaseExists(adminQuery, databaseName)` — reuse
the d31e98f3 helper (base-DB no-op; `pg_database` check; quoted `CREATE DATABASE` only-if-absent) via
a connection to the **maintenance database** (CREATE DATABASE cannot run in a transaction or on the
project pool); (2) bootstrap the **project** schema (D4) in the new DB; (3) seed its hinge rows
(`teams`/`projects` for that identity); (4) register the pool. Idempotent; runs once per project per
process lifetime.

### D6 — Routes: data → `req.databasePool`, account → base pool
The 52 `this.options.pool` uses split by table class (D4). Auth, rate-limit, quota, and metering
middleware run **before** DB-resolution (auth must set `authContext` first) and read account tables —
they legitimately stay on the base pool. Only project-data reads/writes move to `req.databasePool`.
Because no query joins across the boundary, **no SQL bodies change** — only the pool handed to them.
`api_keys` lives in the base DB only, which also resolves where `ensureProjectIdentity`
(`session-init.ts:117`) mints keys: it must explicitly target the **base** pool, not
`getSharedPostgresPool()`'s ambient value.

### D7 — First-request identity (Important gap, resolved)
Verified: `buildServerContext` refuses to send a request without both a key and a `projectId`
(`runtime-selector.ts:129-136`). Therefore **every** request reaching the server carries a real
`projectId`, and the middleware never needs to mint markers. If no projectId can be resolved even so,
respond **400** — never silently fall back to the base database (that reintroduces the leak).
(Pre-existing, unchanged: a project's very first `session-init` mint can no-op if the DB is briefly
unreachable, and the client stays silent until the next session. Not introduced here.)

### D8 — Reuse path stays as-is
With per-request routing the `start` `reuse` early-return is correct: a second project reuses the
running server, and its first data request provisions and routes its own database. `startLocalRuntime`
still resolves the cold-boot project and sets the base URL. No change to the reuse branch.

## Components / change points

1. `src/storage/postgres/pool-registry.ts` (NEW) — `PoolRegistry` (D1, D5), single-flight.
2. `src/server/middleware/resolve-request-database.ts` (NEW) — `resolveRequestDatabase` (D2).
3. `src/server/middleware/postgres-auth.ts` — local-dev bypass populates `authContext.projectId` from
   the request, falling back to `localDevProjectId` (D2).
4. `src/storage/postgres/schema.ts` — split into account/project schema SQL + hinge; mode parameter (D4).
5. `src/server/routes/v1/ServerV1PostgresRoutes.ts` — classify 52 pool uses; mount middleware after auth (D6).
6. `src/server/dashboard/routes.ts` — pool from `authContext` via registry; filter scope unchanged (D3).
7. `src/server/runtime/create-server-service.ts` — construct the registry (base pool seeded), pass to routes/dashboard.
8. `src/cli/handlers/session-init.ts` — mint identity/keys against the base pool explicitly (D6).
9. `req` typing — add `databasePool?: PostgresPool`.
10. **Non-request paths (D9)** — the generation worker and the legacy `/api/*` compat adapters also
    reach project data; see D9.
11. **No change:** MCP server (HTTP client), embedder, `resolve-project-database.ts` (reused),
    `startLocalRuntime` cold boot.

### D9 — Non-request paths must route too (added after the whole-branch review)

The first version of this spec scoped routing to the HTTP request path and asserted "MCP needs no
change" without auditing the other surfaces that reach project data. That was a **design gap**, and
it produced two Critical defects that per-task reviews could not catch (each task's sweep was scoped
to route files, so a pool bound at construction time in a different file was invisible).

**The rule, stated generally:** the unit to audit is not "a pool used in a route" but **"a
project-data table reached without a `req`."** Every such path must resolve the project pool from
whatever scope it *does* have.

Two instances, both live:

- **Generation worker** (`create-server-service.ts` → `ActiveServerGenerationWorkerManager` →
  `ProviderObservationGenerator` → `processGeneratedResponse`) is constructed with the base pool. Its
  job payloads already carry `{ team_id, project_id }`, so it must resolve the pool **per job**.
  Consequence if unrouted: the worker looks for a non-base project's job on the base pool, finds
  nothing, logs "nothing to do" and reports success — **silently dropping every observation for every
  non-base project.**
  It additionally opens one transaction spanning project-data repos *and* `audit_log` (an account
  table); after the schema split no single database satisfies that, so the account writes
  (`audit_log`, `usage_events`) must move to the base pool **outside** the project transaction, and
  must be best-effort so telemetry failure cannot roll back the observation persist.
- **Legacy `/api/*` compat adapters** (`SessionsObservationsAdapter`, `SessionsSummarizeAdapter`) are
  mounted without `dbRouting` and write project data on the base pool. They have live callers (the
  OpenCode integration and the Viewer UI's Observations tab), so they must mount the same middleware
  and thread `req.databasePool`.

**Routing key by path type:** request paths route from `authContext` (D2); worker paths route from the
job's own persisted scope. Neither ever routes from client-supplied query/body fields — so these were
*unrouted*, not *mis-routed*: a completeness gap, not an authorization hole.

**Durable guard:** the isolation test must cover the generation path, asserting a generated
observation for project B lands in B's database. Structural review of route files cannot substitute
for exercising a non-request path end to end.

## Data flow (after)

```
request → auth middleware (sets authContext; local-dev bypass takes projectId from the request)
        → resolveRequestDatabase:
             databaseName = msp_<authContext.projectId>   (base DB name for the cold-boot/legacy project)
             req.databasePool = await registry.getPool(databaseName)   // provisions on first touch
        → data handlers use req.databasePool
          account middleware/handlers (auth, rate, quota, metering, keys) used the BASE pool
shared, one each: process, Express, embedding model, generation logic
```

## Error handling

- No resolvable `authContext.projectId` → **400**. Never fall back to the base DB.
- Provisioning failure → **500** for that request; do not cache a broken pool; retried next request.
  Never fall back to another project's DB.
- Provisioning uses a maintenance-DB connection (not a project pool, not in a txn).
- Registry pools closed on server stop.

## Security (safety-critical core)

- **Single routing source:** the database is chosen from `authContext.projectId` and nothing else
  (D2). In api-key mode that value is authenticated; request-supplied ids are ignored for routing.
- **Dashboard:** `?projectId=` filters rows; it cannot select a database (D3).
- **local-dev:** routing follows the loopback-trusted client's own project — a single-user machine
  boundary, not multi-tenant. The dogfood routes to its existing database, untouched.
- Provisioning only ever `CREATE`s new databases; never `DROP`/`ALTER` an existing one.

## Testing

1. **Unit — PoolRegistry:** caches; provisions once on first create (injected fakes); single-flight
   under concurrent `getPool`; base name maps to the base pool.
2. **Unit — routing key:** api-key mode ignores request-supplied `projectId`; local-dev takes it from
   the request, else `localDevProjectId`; neither → 400.
3. **Unit — dashboard separation (Critical regression guard):** a request whose `authContext.projectId`
   is A but with `?projectId=B` resolves the pool for **A** (and only filters by B). This test must
   fail if anyone reintroduces param-driven pool selection.
4. **Unit — schema split:** account bootstrap creates account tables + hinge, not data tables;
   project bootstrap creates data tables + hinge, not `api_keys`/`team_members`/etc.
5. **Integration (opt-in, dogfood-guarded):** on a throwaway server (non-`:55433`, temp dir), two
   requests with different authenticated projectIds land in different databases (A's write invisible
   to B) — the exact P3 gap. Provisioning idempotent. Hard-refuses `~/.memsmith`/`:55433`.
6. **Regression:** existing single-project behavior unchanged; all current V1/dashboard tests green.
7. **Manual acceptance = P3:** fresh temp project with the dogfood running → routes to its own DB →
   dashboard shows its own data → Go Team converts only its DB.

## Global constraints

- Branch from `main` (`d31e98f3`). Never commit to `main`. Merge `--no-ff` recording a pre-merge
  rollback SHA. Nothing pushed (local only).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood never at risk.** It routes to its existing database (marker pinned). No `DROP`/`ALTER` of
  any existing database; the schema split adds no destructive migration (its DB already has every
  table and remains the base). Integration tests use a throwaway dir + non-`:55433` port.
- **Security invariant (review focus):** routing derives from `authContext` only.
- No new dependencies.
- Sonnet implementers + per-task review + broad Opus review, per standing instruction.

## Cost note (honest)

This is ~4-6 tasks, not 2-3. The schema split (D4) is the risky one; classifying and re-pointing ~124
query sites is broad but mechanical (no SQL rewrites, per the no-cross-joins finding). Option B
(process-per-project) needs no schema work but costs N processes, dynamic ports, and supervision;
A was chosen to keep one shared process and one shared model.

## Relationship to prior work / open follow-ups

- Completes d31e98f3 (which isolated only the cold-boot project). Unblocks P3.
- Follow-ups (unchanged): `npx install` retired-worker reference; `resolveLocalScope`-against-test-PG
  coverage; dashboard api-key-mode 401 on keyless load; **new:** `buildScope`'s unauthenticated
  query-param filter override deserves its own authz review.
