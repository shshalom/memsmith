# Embedded Postgres Local Runtime — Design

> **Status:** Design approved (Sections 1–4), pending written-spec review.
> **Date:** 2026-07-11.
> **Scope:** Subsystem #1 of the "unify on Postgres" north star. This spec covers ONLY the
> embedded-Postgres `local` runtime. It deliberately does NOT cover subsystem #2
> (private↔team unification / retiring the worker+SQLite runtime) or subsystem #3
> (team identity & access). Those get their own specs.

## Problem

MemSmith has two runtimes today:

- **worker** — SQLite (`~/.memsmith/memsmith.db`), single-user, FTS-only, no team features.
  This is the plugin's default and what users actually run.
- **server** — Postgres + pgvector + Redis/BullMQ, semantic search, all the settings/cost work,
  team-capable. Requires Docker (or a hosted PG + Redis) to stand up.

Every capability we build lands in server-mode (Postgres). But the installed plugin runs
worker-mode (SQLite). So users get almost none of the built value, and "going team" requires a
manual SQLite→Postgres migration. This split is a historical artifact (SQLite inherited from
claude-mem; Postgres added later for team), not a principled boundary.

**Goal of this subsystem:** a zero-setup `local` runtime that runs the *server* code path against
an **embedded Postgres** (real PG + pgvector, no Docker, no Redis) — so a solo user gets semantic
search and every server-mode capability locally, and any project can later become a team with no
data migration.

## Feasibility (verified)

Spike verified on darwin arm64: `@boomship/postgres-vector-embedded` v0.2.2 ships real PostgreSQL
17.5 + pgvector 0.8.0 as a downloadable binary (no Docker). `vector(384)` columns, HNSW indexes,
cosine `<=>` distance, and full-text search all work. It exposes a standard `pg` connection string,
which is exactly what the storage layer already consumes (`src/storage/postgres/pool.ts:14`
`createPostgresPool({ connectionString })`).

Package API (validated):
- Exports: `PostgresServer`, `downloadBinaries`, `detectPlatform`, `getDownloadUrl`.
- `downloadBinaries({ targetDir, variant: 'lite' })` — fetches from a GitHub release. NOT automatic
  on construct.
- `new PostgresServer({ binariesDir, dataDir, port, username, password })` →
  `initialize()` → `start()` → `waitForReady()` → `getConnectionString()` → standard `pg.Client`.
- **Risk:** niche, single-maintainer package. Validate linux/windows during the real build.
  Isolating all package contact inside one manager (below) keeps the blast radius small if it must
  be swapped.

## Section 1 — Architecture (APPROVED)

A thin `EmbeddedPostgresManager` sits in front of the existing, unchanged server runtime:

1. `ensureBinary()` — ensures the PG+pgvector binary is present; download-on-first-run, cached at
   `~/.memsmith/pg-binaries/`.
2. `start()` — starts a local Postgres against `~/.memsmith/pgdata/` on a fixed loopback port.
   Idempotent: if a healthy instance we own is already up, reuse it.
3. `getConnectionString()` — returns a standard PG connection string.

The `local` runtime entrypoint then sets `MEMSMITH_SERVER_DATABASE_URL` to that connection string
and calls the **existing** `createServerService()` (`src/server/runtime/create-server-service.ts:182`)
unchanged. The server already speaks connection strings, so the storage layer needs ~zero change.

Runtime selection: `MEMSMITH_RUNTIME` gains a third value `local` (today: `worker | server`).
`local` == "server code path, embedded PG + inline queue, loopback, single user."

```
MEMSMITH_RUNTIME=local
  └─ EmbeddedPostgresManager.ensureBinary()   (download once → ~/.memsmith/pg-binaries/)
  └─ EmbeddedPostgresManager.start()          (postgres child vs ~/.memsmith/pgdata/, port 55433)
  └─ conn = getConnectionString()
  └─ process.env.MEMSMITH_SERVER_DATABASE_URL = conn
  └─ createServerService()                    (UNCHANGED — full server capabilities)
       ├─ pgvector semantic search
       ├─ settings / cost / generation pipeline
       ├─ embed-on-write
       └─ inline queue (Section 2)
```

**Isolation:** all `@boomship/postgres-vector-embedded` contact lives inside
`EmbeddedPostgresManager`. Nothing else imports the package. If the package is replaced, only the
manager changes.

## Section 2 — Queue engine: `inline` (APPROVED)

The server hard-requires Redis + BullMQ *in Docker only*. `validateServerEnv`
(`create-server-service.ts:123-132`) enforces `QUEUE_ENGINE=bullmq` **only when `isDocker`** is
true; outside Docker any engine is allowed. The code comment at line 53 ("no in-memory queue in
Docker") already implies an in-memory local path is intended.

**Decision:** add a third `MEMSMITH_QUEUE_ENGINE=inline` — an in-process, in-memory queue. Local
mode is single-process and single-user, so it does not need Redis's durability or cross-process
fan-out.

Two swap points, both small:
- `buildQueueManager()` (`create-server-service.ts:330`): add
  `if (config.engine === 'inline') return new InlineServerQueueManager(...)` before the disabled
  fallback.
- `buildGenerationWorkerManager()` (`create-server-service.ts:232`): today it hard-checks
  `queueManager instanceof ActiveServerQueueManager` and disables otherwise. Widen it to also accept
  `InlineServerQueueManager` so the full generation pipeline (provider-holder hot-swap,
  embed-on-write, quality knobs) runs on the inline queue.

`InlineServerQueueManager` implements the `ServerQueueManager` interface (`types.ts:41` —
`kind`/`getHealth`/`close`) plus the small `ServerJobQueue` surface the generation worker actually
uses: `add(jobId, payload, opts)`, `start(processor)`, `getCounts()`, `observe(listener)`,
`getLifecycleCounters()`, `close()`. Internally it is an async task list with bounded concurrency;
`add` enqueues, the registered processor drains.

- **Durability:** jobs are lost on process death. Acceptable locally — generation is best-effort and
  re-derivable from the raw session; there is exactly one process and one user.
- **Health honesty:** `/api/health` reports `engine: 'inline'` so the dashboard never claims Redis
  is present when it is not.

Net effect: local mode reuses the *entire* generation pipeline. The only thing that changes beneath
it is the transport. All server-mode capabilities carry over.

## Section 3 — Process lifecycle: resident daemon (APPROVED)

`EmbeddedPostgresManager` owns the `postgres` child process; the `local` runtime entrypoint owns the
manager. Boot order: `ensureBinary()` → `start()` (idempotent) → `getConnectionString()` → set
`MEMSMITH_SERVER_DATABASE_URL` → `createServerService()`.

- **Resident, not per-session.** Postgres survives session exit. The next session's `start()`
  detects the healthy instance and connects instantly (no cold boot). Explicit teardown via a new
  `memsmith local stop` command, which runs `pg_ctl stop -m fast`.
- **Single-process ownership reuses existing machinery.** Locking uses
  `src/services/infrastructure/ProcessManager.ts` — the same `writePidFile` / `readPidFile` /
  `removePidFileIfOwner` / `isProcessAlive` utilities the worker already uses for its own
  single-instance guarantee. A dedicated PID file (`~/.memsmith/local-pg.pid`) tracks the PG owner.
  A second MemSmith launch reads it: PID alive → connect to the same PG; PID dead → stale lock,
  recover.
- **Port selection.** Fixed loopback default `MEMSMITH_LOCAL_PG_PORT` = `55433` (distinct from the
  dogfood `55432`). On start: if the port is taken, probe whether it is *our own* healthy instance
  (connect + `SELECT 1` + data-dir marker) → reuse; if it is a foreign process → fail loud with a
  clear message. Never wander to a random port (a wandering port breaks reconnect after restart).
- **Crash safety.** Postgres WAL crash-recovers its own data-dir. Stale-lock detection (PID not
  alive via `isProcessAlive`) recovers the manager side.

## Section 4 — First-run import: taxonomy-aware (APPROVED)

On first `local` boot, if `~/.memsmith/memsmith.db` (worker SQLite) exists AND the PG `observations`
table is empty, run a one-shot import, then write a marker so it never re-runs. SQLite is left
untouched as a backup. `ON CONFLICT DO NOTHING` keeps it idempotent.

This generalizes the proven `scripts/migrate-claude-mem.ts` ETL (validated on 2,378 rows). **But the
current ETL is verbatim-passthrough** — `obsType = row.type` (line 112) and a crude
`decision→active, else→resolved` (line 113). That was fine for claude-mem-shaped rows, but a general
worker→local importer cannot assume the source labels map cleanly onto server-mode's taxonomy.
Passing them through blindly would pollute the dashboard decision log, the lifecycle board, and the
retrieval boost (`quality.ts:5` `HIGH_SIGNAL_TYPES = {decision, gotcha, blocker}`).

**Refinement: the local model reclassifies rows into MemSmith's canonical taxonomy.**

- **Canonical target taxonomy** is mode-defined, loaded at runtime from the active mode's
  `observation_types` (NOT hardcoded), so it always matches the installed mode. The active `code`
  mode (`plugin/modes/code.json`) defines 8 types: `bugfix`, `feature`, `refactor`, `change`,
  `discovery`, `decision`, `security_alert`, `security_note`. Lifecycle states in use: `active`,
  `resolved`, `blocked`.
- The importer batches rows whose source type is NOT already a valid canonical type and asks the
  **local Ollama model** (already running: `MEMSMITH_PROVIDER=ollama`, `qwen2.5:14b`) to classify
  each into one canonical `obs_type` + a lifecycle state. Private, offline, no cloud cost — the
  honest use of the local-model capability.
- **Guardrails:**
  - If the source type is already a valid canonical type, keep it (no needless reclassification, no
    model drift). Only unknown/ambiguous types go to the model.
  - Model output is validated against the mode's type set; an invalid label falls back to `change`
    (generic bucket) rather than corrupting the taxonomy.
  - All original source fields are preserved in `metadata` (as the ETL already does), so nothing is
    lost and a re-run can re-derive.
- Second half unchanged: `scripts/backfill-embeddings.ts` embeds imported rows (local ONNX
  all-MiniLM-L6-v2, 384-dim) so semantic search works immediately on the imported history.

## Components & responsibilities

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `EmbeddedPostgresManager` | Own the embedded PG binary + process: ensure binary, start/stop, connection string, PID/lock, port. Sole point of contact with `@boomship/postgres-vector-embedded`. | `ProcessManager` (pidfile), the embedded-PG package |
| `local` runtime entrypoint | Wire manager → `MEMSMITH_SERVER_DATABASE_URL` → `createServerService()`. Handle `MEMSMITH_RUNTIME=local`. | `EmbeddedPostgresManager`, `createServerService` |
| `InlineServerQueueManager` | In-process queue implementing `ServerQueueManager` + the `ServerJobQueue` surface the worker uses. | `ServerQueueManager` interface, `ServerGenerationJobPayload` types |
| First-run importer | One-shot idempotent SQLite→PG import with taxonomy-aware reclassification via local model; then embedding backfill. | existing ETL + backfill scripts, active mode config, Ollama provider |
| `memsmith local stop` (CLI) | Clean teardown of the resident PG (`pg_ctl stop -m fast`), clears the PID file. | `EmbeddedPostgresManager` |

## Data flow

```
observation write (hook/API)
  → createServerService HTTP route
    → enqueue generation job  → InlineServerQueueManager.add()
      → processor drains (bounded concurrency)
        → provider generation (Ollama local / Claude / etc. via provider-holder)
          → embed-on-write (ONNX 384-dim)
            → persist to embedded Postgres (observations + embedding_vec)
  → /v1/search: hybrid FTS + pgvector RRF fusion over the embedded PG
```

## Error handling

- **Binary download fails:** `ensureBinary()` surfaces a clear, actionable error (network / platform
  unsupported); does not silently fall back to worker/SQLite (that would hide the failure and
  re-fragment storage).
- **Port occupied by foreign process:** fail loud with the port and a remediation hint; never pick a
  random port.
- **Stale lock (PID dead):** detected via `isProcessAlive`; recover by re-starting PG (WAL
  crash-recovers the data-dir).
- **Inline queue job failure:** logged; job dropped (best-effort, re-derivable). No crash of the
  service.
- **Import classification failure (Ollama unreachable/invalid output):** fall back to `change`;
  never block the import or corrupt the taxonomy. Import remains resumable (marker only written on
  success).

## Testing strategy

- `EmbeddedPostgresManager`: unit tests for lock/port/reuse logic with the process layer stubbed;
  one integration test that actually boots embedded PG (gated to darwin/linux) and runs
  `SELECT 1` + a `vector` round-trip.
- `InlineServerQueueManager`: unit tests for enqueue → drain, bounded concurrency, `getCounts`,
  health reports `engine: 'inline'`, `close()` idempotency. Reuse the existing queue-manager test
  shape.
- `buildQueueManager` / `buildGenerationWorkerManager`: tests that `engine=inline` yields the inline
  manager and an ACTIVE (not disabled) generation worker.
- First-run importer: taxonomy classification guardrails (valid type kept; unknown → model; invalid
  model output → `change`), idempotency marker, empty-table precondition, metadata preservation.
- Non-Docker env validation: `MEMSMITH_QUEUE_ENGINE=inline` passes `validateServerEnv` outside
  Docker and is rejected inside Docker.

## Out of scope (future subsystems)

- **#2 private↔team unification:** a connection-target flag to point the same code at a remote team
  PG; retiring worker/SQLite as legacy. This spec makes it *possible* (local is already the server
  shape) but does not implement the switch.
- **#3 team identity & access:** owners, members, self-serve API keys, multi-user auth, attribution.
- Windows/linux binary validation of the embedded-PG package (do during the build).
- Migrating the plugin default from `worker` to `local` (a rollout decision, separate).

## Code anchors (for the implementer)

- Runtime factory & env validation: `src/server/runtime/create-server-service.ts`
  (`:123-142` validation, `:182` `createServerService`, `:193`/`:330` `buildQueueManager`,
  `:232` `buildGenerationWorkerManager`).
- Queue interface: `src/server/runtime/types.ts:41` `ServerQueueManager`,
  `:85` `DisabledServerQueueManager`.
- Active queue reference impl: `src/server/runtime/ActiveServerQueueManager.ts`.
- Job queue surface to mirror: `src/server/jobs/ServerJobQueue.ts`
  (`add`, `start`, `getCounts`, `observe`, `getLifecycleCounters`, `close`).
- Storage pool: `src/storage/postgres/pool.ts:14` `createPostgresPool({ connectionString })`.
- Pidfile utilities: `src/services/infrastructure/ProcessManager.ts`.
- ETL to generalize: `scripts/migrate-claude-mem.ts` (`transform` at `:94`,
  taxonomy passthrough at `:112-113`). Embedding backfill: `scripts/backfill-embeddings.ts`.
- Taxonomy source: active mode `plugin/modes/code.json` `observation_types`; fallback list at
  `src/server/generation/providers/shared/prompt-builder.ts:15`. Retrieval boost:
  `src/server/generation/quality.ts:5`.
