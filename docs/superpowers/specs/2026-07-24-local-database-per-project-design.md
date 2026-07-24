# Local Database-Per-Project — Design

**Date:** 2026-07-24
**Status:** Approved (design). Ready for implementation planning.
**Severity:** High — the real fix for finding #3 (dogfood-vs-project data-dir collision) that
blocks P3 and any multi-project-per-machine use.

## Problem

In local mode, ONE embedded Postgres server (`~/.memsmith/pgdata`, `:55433`) hosts a SINGLE
database (`postgres`), and every local project is a co-tenant in it — separated only by a
`team_id`/`project_id` column, never physically. Observed live: the dogfood (proj `5fc024f0`,
4103 obs) and a throwaway temp project (proj `a1eafc94`, 1 obs) sit in the same `postgres`
database. Consequences:

- **No isolation** — a second project on the machine (e.g. the P3 temp project) lands in the
  dogfood's database. This is finding #3; `.claude/settings.json env` cannot isolate it because
  `resolveDataDir`'s `DATA_DIR` is a module-level const resolved once at import from
  `process.env`, which is unset in the plugin hook subprocess.
- **Go Team risk** — converting a project would operate against a store shared with the dogfood.

## Goal

Each local project gets its **own PostgreSQL database** inside the one embedded server. Physical
isolation: a connection to project A's database cannot see project B's tables. The dogfood keeps
using its existing database **unchanged** (no data moved). New projects get fresh databases. This
unblocks P3 and makes multi-project-per-machine safe.

## Non-goals / clarifications

- NOT database-per-*process* (rejected: N Postgres processes/ports/boots per machine, too heavy).
  ONE server, N databases inside it.
- NOT table-per-project in a shared DB (that is essentially today's shared model).
- No data migration of the dogfood: it stays in its current database, untouched. The only data
  operation is deleting 1 leaked row (§ Cleanup).
- Team mode / Go Team convert is unchanged by this spec (it already copies a project's data to the
  remote; with db-per-project it reads from the project's own DB — cleaner, no change needed now).

## The model

```
ONE embedded PG server (:55433, ~/.memsmith/pgdata, one process, one boot)
 ├── database "postgres"        ← dogfood (proj 5fc024f0): full schema, 4103 obs — UNCHANGED
 ├── database "msp_a1eafc94..." ← a project: its OWN full schema (observations, agent_events, …)
 └── database "msp_<projectId>" ← each new project = its own database
```

Everything funnels through one seam: `startLocalRuntime` sets `MEMSMITH_SERVER_DATABASE_URL`
(`local-runtime.ts:22`) to the connection string; all downstream consumers
(`getSharedPostgresPool`, the server engine, dashboard, MCP) read from that URL. Per-project
routing = compute the right database name and build that URL before the pool is created.

## Decisions

### D1 — Database naming
The per-project database name is derived from the marker's `projectId`:
`msp_<projectId with dashes removed>` (e.g. `msp_a1eafc94039f4369920fb8ba6bd43b03`). Rationale:
`projectId` is the unique per-project identity, already in the marker; a stripped UUID satisfies
PG's identifier length (63) / charset rules. The **project** (not team) is the isolation unit — a
team can have multiple local projects on one machine.

### D2 — Dogfood stays on `postgres` (pinned via marker, never moved)
The marker (`.memsmith/project.json`) gains an optional `databaseName` field recording which
database the project uses. Resolution order for a project's database name:

1. If the marker has `databaseName` → use it (authoritative; sticky).
2. Else, back-compat detection: connect to `postgres` and check whether it already contains this
   project's rows (`SELECT 1 FROM observations WHERE project_id = $1 LIMIT 1`, guarded — table may
   not exist on a truly fresh install). If yes → this is a legacy project already living in
   `postgres`; adopt `databaseName = "postgres"` and **stamp the marker** so detection runs once.
3. Else (new project) → `databaseName = "msp_<projectId>"`; stamp the marker.

This pins the dogfood to its existing `postgres` database forever, with no move/copy/rename. The
stamp is written once; subsequent boots read the marker directly.

### D3 — Boot flow (the single seam)
In the local-runtime boot path (`startLocalRuntime` and/or the resolver it calls), BEFORE building
the pool / setting `MEMSMITH_SERVER_DATABASE_URL`:

1. Read the project marker; resolve `databaseName` per D2 (using a short-lived admin connection to
   the `postgres` maintenance DB for the back-compat check).
2. `CREATE DATABASE <databaseName>` if it does not exist (skip when name === `postgres`). PG has no
   `CREATE DATABASE IF NOT EXISTS`; use the standard guard: check
   `SELECT 1 FROM pg_database WHERE datname = $1`, create only if absent. Run on the `postgres`
   maintenance connection. This path ONLY creates; it never drops/alters an existing database.
3. Build the connection string targeting `<databaseName>` (extend
   `EmbeddedPostgresManager.buildConnectionString` to accept a database-name argument, default
   `postgres` for back-compat) and set `MEMSMITH_SERVER_DATABASE_URL` to it.
4. Run `bootstrapServerPostgresSchema` against that database (existing idempotent bootstrap; on the
   dogfood's `postgres` DB it's a safe no-op since the schema already exists).

Downstream (`getSharedPostgresPool`, server engine, dashboard, MCP) is unchanged — it reads the
now-project-scoped `MEMSMITH_SERVER_DATABASE_URL`.

### D4 — Dogfood marker stamp (one-time, in this branch)
As part of this change, stamp the dogfood project's marker
(`/Users/shwaits/Workspace/team-agent-memory/.memsmith/project.json`) with
`databaseName: "postgres"` so it is explicitly pinned (belt-and-suspenders on top of the D2
detection). This is a marker edit, not a data operation.

### D5 — Cleanup: delete the leaked temp row
Delete the single leaked row for proj `a1eafc94` from the dogfood `postgres` database (it was
written there by an earlier isolation-less temp session and does not belong). One `DELETE`,
scoped by `project_id`, run once. Verify the dogfood count is otherwise unchanged (4103 → 4103;
the leaked row is separate).

## Components / change points

1. `src/server/runtime/EmbeddedPostgresManager.ts` — `buildConnectionString(databaseName = 'postgres')`
   (currently hardcodes `/postgres`). `start()`/`getConnectionString()` keep returning the default
   `postgres` string; per-project targeting happens in the boot resolver (below), which builds its
   own string from host/port/creds + the resolved DB name.
2. New module (e.g. `src/server/runtime/resolve-project-database.ts`) — `resolveProjectDatabaseName(cwd, adminPool)`:
   implements D2 (marker → back-compat detect → mint) + stamps the marker; and
   `ensureDatabaseExists(adminPool, name)`: implements D3.2 (`pg_database` check + `CREATE DATABASE`).
3. `src/server/runtime/local-runtime.ts` (`startLocalRuntime`) — after `EmbeddedPostgresManager.start()`
   (which boots the server + gives the base `postgres` URL), resolve the project DB name, ensure it
   exists, and set `MEMSMITH_SERVER_DATABASE_URL` to the project-scoped URL BEFORE the import/bootstrap
   + server loop. The existing `defaultRunImport` schema bootstrap now runs against the project DB.
4. `src/services/identity/project-identity.ts` — marker type gains optional `databaseName`; a writer to
   stamp it (mirroring the existing marker-merge writers, never writing a secret).
5. Docs / one-time ops (D4, D5) — dogfood marker stamp + leaked-row delete, done as guarded steps in
   this branch's execution (not shipped code).

## Data flow (after)

```
project session boot → startLocalRuntime
  → EmbeddedPostgresManager.start()  (server up, base postgres URL)      [unchanged]
  → resolveProjectDatabaseName(cwd, adminPool):
       marker.databaseName ? use it
       : postgres has this project's rows ? adopt "postgres" (stamp marker)
       : "msp_<projectId>" (stamp marker)
  → ensureDatabaseExists(adminPool, name)   (CREATE DATABASE if absent; skip for postgres)
  → MEMSMITH_SERVER_DATABASE_URL = postgres://…:55433/<name>
  → bootstrapServerPostgresSchema(project DB) + import + server loop
  → server engine / dashboard / MCP read the project-scoped URL             [unchanged]
```

## Error handling

- `CREATE DATABASE` cannot run inside a transaction and needs the `postgres` maintenance DB — use a
  dedicated short-lived admin connection, not the pooled project connection. Close it after.
- Back-compat probe (`SELECT … FROM observations`) must tolerate a fresh `postgres` DB where the
  table doesn't exist yet (catch → treat as "no rows" → mint a new DB). Guard so a probe failure
  never blocks boot.
- If DB creation fails (permissions, disk), boot fails loud with a clear message — do not silently
  fall back to the shared `postgres` DB (that would reintroduce the leak).
- Marker stamp write failure is non-fatal for the current boot (the name was resolved), but logged;
  next boot re-detects. Never abort a working runtime over a marker write.

## Testing

1. **Unit — name derivation:** `resolveProjectDatabaseName` returns `marker.databaseName` when set;
   `postgres` when the probe finds this project's rows (stamps marker); `msp_<projectId>` otherwise
   (stamps marker). Inject a fake admin pool + fake marker read/write.
2. **Unit — `ensureDatabaseExists`:** issues `CREATE DATABASE` only when `pg_database` lacks the
   name; no-ops when present; never for `postgres`. Fake pool asserts the queries.
3. **Unit — connection string:** `buildConnectionString('msp_x')` targets `/msp_x`; default targets
   `/postgres` (back-compat).
4. **Integration (opt-in, dogfood-guarded):** against a throwaway embedded PG on a non-`:55433`
   port + temp data dir: boot two distinct project markers, assert each gets its own database, that
   writing an observation under project A is INVISIBLE from project B's database connection
   (physical isolation), and idempotent re-boot reuses the same DB. Self-skips without opt-in; hard
   dogfood guard (refuse `~/.memsmith` / `:55433`).
5. **Back-compat:** a marker with no `databaseName` against a `postgres` DB that already has that
   project's rows → resolves `postgres` (not a new DB), so an existing dogfood-style install keeps
   its data. (Covered by test 1's probe-hit case; the integration test may also seed this.)
6. **One-time ops verification (D4/D5):** after stamping the dogfood marker + deleting the leaked
   row: dogfood marker has `databaseName:"postgres"`; dogfood obs count is its true count (4103),
   and the `a1eafc94` row is gone. Verified against the live dogfood with a backup-first snapshot of
   the row(s) touched.

## Global constraints

- Branch from `main` (`ca1ed790`). Never commit to `main`. Merge `--no-ff` recording a pre-merge
  rollback SHA. Nothing pushed (local only).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood must never be at risk.** The dogfood stays in its existing `postgres` database,
  untouched. `CREATE DATABASE` only creates; never drops/alters. The D5 delete is scoped to the
  leaked `a1eafc94` row ONLY, backup-first, count-verified. Integration tests use throwaway data
  dir + non-`:55433` port and hard-refuse the dogfood.
- The team API key stays in `CredentialStore`, never in the marker (marker gains only `databaseName`,
  a non-secret).
- No dependency changes. Schema unchanged (per-project DBs get the SAME existing schema via the
  existing bootstrap).
- Sonnet implementers + per-task review + broad Opus review, per standing instruction.

## Relationship to prior work / open follow-ups

- Fixes finding #3 (data-dir isolation) — the last blocker for P3. After this, the temp project
  runs in its own database, Go Team converts only that database, dogfood is physically untouchable.
- Both cold-boot bugs already fixed (`308aeef0` runtime-aware start, `ca1ed790` auto-daemonize).
- Unchanged open items: `npx install` references retired `worker-service.cjs`;
  `resolveLocalScope`-against-test-PG coverage gap; dashboard `api-key`-mode 401 on keyless load
  (separate cosmetic issue — the runtime restarted without local-dev-bypass flags; not this spec).
- Per-project data-dir (vs per-project database): this spec isolates at the DATABASE layer inside
  one shared data dir/server. That is sufficient for physical table isolation. A future step could
  additionally isolate the data dir, but it is not needed for the collision fix.
