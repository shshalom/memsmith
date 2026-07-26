# Per-Request Database Routing — Design (Option A)

**Date:** 2026-07-26
**Status:** Approved (design). Ready for implementation planning.
**Severity:** High — completes local database-per-project (d31e98f3), which does not isolate a
SECOND concurrent project on a shared server. Unblocks P3 and true multi-project-per-machine.

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
project's database pool based on the request's identity. The dogfood keeps its `postgres` database,
untouched.

## Key enabling facts (verified)

- The embedding model is already a **module-level singleton** (`embedder.ts`: `let extractorPromise`
  loads once). One model already serves the whole process — sharing it across projects is free. The
  earlier "N models" cost was purely an artifact of Option B (N processes); it does not apply here.
- Every request already carries project identity: `req.authContext.{teamId, projectId}` (auth
  middleware) in api-key mode; the local client (`ServerClient`) also sends `projectId` in the
  request body.
- The server is built around ONE injected pool: `create-server-service.ts:194` builds it and threads
  it into V1 routes (`this.options.pool`, ~54 uses), dashboard (`options.db`), auth, metering.
- **MCP needs no change** — it is a separate process that talks to the server over HTTP via
  `ServerClient` (sends `projectId` in the body); server-side per-request routing handles it.

## Approach

Introduce a **pool registry** (`Map<databaseName, Pool>`, get-or-create + cached) and a
**per-request DB-resolution middleware** (runs after auth) that sets `req.databasePool` to the pool
for the request's effective project database. Route handlers use `req.databasePool` instead of the
single construction-time pool. The embedding model, Express app, and generation logic stay shared
and singular.

### Effective projectId (the routing key) — two identity sources

- **api-key / team mode:** `databaseName = msp_<authContext.projectId>`. The DB is bound to the
  AUTHENTICATED identity — a request can only reach its own project's DB. (Auth-bound; safe by
  construction.)
- **local-dev mode (loopback bypass):** the bypass currently stamps a boot-time constant
  `localDevProjectId` — which is the second-project bug. Since local-dev is the loopback-trusted,
  single-user-on-their-own-machine path, the effective projectId becomes the **request's own
  projectId** (from the request body / an explicit param the client already sends), falling back to
  `localDevProjectId` only when the request carries none. This is safe SPECIFICALLY because it is the
  local-dev loopback path (not a multi-tenant trust boundary); in api-key mode the request-supplied
  projectId is NEVER trusted over the authenticated one.

### First-touch database provisioning (fixes the reuse-path gap)

Because a second project now joins a *running* server, its database must be provisioned on first
use, not at cold boot. The DB-resolution middleware, on a cache miss for `databaseName`:
1. `ensureDatabaseExists(adminPool, databaseName)` (reuse the d31e98f3 helper — `postgres` no-op;
   `pg_database` check; quoted `CREATE DATABASE` only-if-absent) via a short-lived admin pool on the
   base `postgres` URL.
2. `bootstrapServerPostgresSchema(newPool)` for the project DB (idempotent).
3. Register the pool in the registry.
This is idempotent and only runs once per project per process lifetime (cached thereafter).

## Decisions

### D1 — Pool registry
A process-level `PoolRegistry`: `getPool(databaseName): Promise<Pool>` — returns the cached pool or
creates it (build URL by swapping the DB segment of the base `postgres` URL:
`new URL(base); u.pathname='/'+dbName`), ensuring the DB exists + schema bootstrapped on first
create. `postgres` (the base/dogfood DB) is a normal entry. The registry owns pool lifecycle
(closed on server stop).

### D2 — DB-resolution middleware (after auth, before route handlers)
`resolveRequestDatabase`: compute effective projectId (D-routing-key above) → `databaseName` →
`req.databasePool = await registry.getPool(databaseName)`. If no projectId can be resolved at all
(neither auth nor request nor local-dev fallback), respond `400` (never silently fall back to
`postgres` — that would reintroduce the leak). Mounted so EVERY data route runs after it.

### D3 — Routes use `req.databasePool`
The ~54 V1 route pool-uses (`this.options.pool`) and the dashboard's `options.db` usage switch to
the per-request `req.databasePool`. Auth/metering/quota middleware that currently take the global
pool: these run BEFORE DB-resolution (auth must set authContext first) and legitimately operate on
the base/admin pool (rate-limit, quota, key lookup are cross-project server-account concerns) — they
stay on the base pool. Only the project-DATA reads/writes (observations, agent_events, sessions,
jobs, dashboard board/queries) move to `req.databasePool`. The spec's plan phase enumerates exactly
which sites are data (→ req pool) vs account (→ base pool).

### D4 — Reuse-path no longer needs per-project boot
With per-request routing, the `start` `reuse` path is CORRECT as-is (a second project reuses the
running server; its first data request provisions + routes its DB). `startLocalRuntime`'s cold-boot
DB-resolution (from d31e98f3) still resolves the FIRST/cold-boot project (the dogfood) and sets the
base URL to that project's DB — which becomes the registry's base. (For the dogfood that is
`postgres`.) No change needed to the reuse early-return.

### D5 — Marker minting for a reuse-path project
A second project joining a running server never runs `startLocalRuntime`, so its marker
(`.memsmith/project.json`) is not minted by the runtime boot. It must be minted elsewhere so the
project has a stable identity + `databaseName`. Options resolved in the plan: the DB-resolution
middleware (or a lightweight per-request identity step) ensures the marker exists for the request's
cwd/identity — OR the client already sends a minted projectId (the hook path mints identity
client-side via `ensureProjectIdentity` before calling the server). The plan will confirm the client
already mints identity before its first server call (the hook/`buildServerContext` path) so the
server only needs to route + provision the DB, not mint markers. If confirmed, D5 is a no-op beyond
provisioning; if not, the middleware mints.

### D6 — Dashboard per-request routing
The dashboard resolves `projectId` per request already (`buildScope`: query param or authContext).
Its queries switch from `options.db` to a pool resolved from that projectId via the registry, so
each project's dashboard shows its OWN database. (This also fixes the P3 "no data / load failure"
symptom for a second project.)

## Components / change points

1. `src/storage/postgres/pool-registry.ts` (NEW) — `PoolRegistry` (D1), reusing
   `ensureDatabaseExists` + `bootstrapServerPostgresSchema` + URL path-swap.
2. `src/server/middleware/resolve-request-database.ts` (NEW) — `resolveRequestDatabase` (D2), plus
   the effective-projectId resolver (auth-bound vs local-dev-request-supplied).
3. `src/server/routes/v1/ServerV1PostgresRoutes.ts` — data routes use `req.databasePool`; account
   middleware stay on base pool (D3). Register the middleware after auth.
4. `src/server/dashboard/routes.ts` — board/queries use a registry-resolved pool (D6).
5. `src/server/runtime/create-server-service.ts` — construct the `PoolRegistry` (seeded with the base
   pool as the `postgres`/cold-boot entry), pass it to routes + dashboard.
6. `req` typing — add `databasePool?: PostgresPool` to the Express request augmentation.
7. **No change:** MCP server (HTTP client), embedder (already singleton), `startLocalRuntime`
   cold-boot resolution (still resolves the first project), `resolve-project-database.ts` (reused).

## Data flow (after)

```
request → auth middleware (sets authContext)
        → resolveRequestDatabase:
             effective projectId = api-key ? authContext.projectId
                                  : local-dev ? (request projectId ?? localDevProjectId)
             databaseName = msp_<projectId>  (or 'postgres' for the dogfood/legacy)
             req.databasePool = await registry.getPool(databaseName)   // provisions+bootstraps on first touch
        → route handler uses req.databasePool  (data reads/writes)
             (account middleware — rate/quota/keys — used the base pool earlier in the chain)
one shared: server process, Express, embedding model, generation logic
```

## Error handling

- No resolvable projectId → `400` (never silent-fallback to `postgres`).
- First-touch `CREATE DATABASE`/bootstrap failure → surface as a `500` for that request; do NOT
  register a broken pool; retried next request. Never fall back to another project's DB.
- Admin pool for provisioning is short-lived (created per provision, closed after) OR a dedicated
  long-lived admin pool on `postgres` for `pg_database` checks + CREATE (plan picks; must be a
  connection to the maintenance DB, not a project pool, since CREATE DATABASE can't run in a txn).
- Registry pools closed on server stop (no leak).

## Security (the safety-critical core)

- **api-key/team:** routing key = `authContext.projectId` (authenticated). A request can NEVER reach
  another project's DB; a request-supplied projectId is ignored in this mode.
- **local-dev:** routing key = the loopback-trusted client's own projectId. This is a single-user
  local trust boundary; there is no cross-tenant exposure (only the machine's owner reaches the
  loopback server). The dogfood's requests carry its projectId → `postgres`; untouched.
- The provisioning path only ever CREATEs new `msp_` DBs; never DROP/ALTER an existing DB.

## Testing

1. **Unit — PoolRegistry:** getPool caches; first-create provisions (ensureDatabaseExists +
   bootstrap) via injected fakes; `postgres` maps to the base pool; concurrent getPool for the same
   name doesn't double-create (single-flight).
2. **Unit — effective projectId resolver:** api-key mode → authContext.projectId (ignores
   request-supplied); local-dev → request projectId, else localDevProjectId; none → error.
3. **Unit — resolveRequestDatabase middleware:** sets req.databasePool from the resolved name; 400
   when no projectId.
4. **Integration (opt-in, dogfood-guarded):** on a throwaway server (non-`:55433`, throwaway dir):
   two requests carrying different projectIds land in different databases (write under A invisible to
   B), proving PER-REQUEST isolation on ONE running server (the exact P3 gap). Idempotent
   provisioning. Self-skips without opt-in; hard dogfood guard.
5. **Regression:** existing single-project (dogfood) behavior unchanged — its requests route to
   `postgres`; all existing V1/dashboard tests still green (they use one project, so `req.databasePool`
   resolves to the same pool they used before).
6. **Manual acceptance = P3:** fresh temp project (dogfood running) → its session's requests route to
   its own `msp_` DB → dashboard shows its own data → Go Team converts ONLY its DB.

## Global constraints

- Branch from `main` (`d31e98f3`). Never commit to `main`. Merge `--no-ff` recording a pre-merge
  rollback SHA. Nothing pushed (local only).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood never at risk.** The dogfood routes to its existing `postgres` DB (marker pinned). No
  DROP/ALTER of any existing DB; provisioning only CREATEs new `msp_`. Integration tests use throwaway
  dir + non-`:55433` port and hard-refuse `~/.memsmith`/`:55433`.
- Security: in api-key mode the routing key is the AUTHENTICATED projectId only; request-supplied
  projectId is never trusted over auth. This invariant is a review focus.
- No new dependency; per-project DBs use the existing schema via existing bootstrap.
- Sonnet implementers + per-task review + broad Opus review, per standing instruction.

## Relationship to prior work / open follow-ups

- Completes d31e98f3 (which only isolated the cold-boot project). Together they deliver true
  multi-project-per-machine isolation with one shared server + one shared model.
- Unblocks P3.
- Rejected Option B (process-per-project): heavier (N processes, N embedding models, dynamic ports,
  supervision). A keeps one lightweight shared process — the product's one-instance-per-machine model.
- Unchanged open items: `npx install` retired-worker reference; `resolveLocalScope`-against-test-PG
  coverage; dashboard api-key-mode 401 on keyless load.
