# Worker Retirement — Phase 3 Safety Gate Results

**Run date:** 2026-07-13 (branch `embedded-pg-local-runtime`, at commit `354cc5a1`).
**Purpose:** Prove the worker runtime is unreachable-safe before Phase 4 deletion.

## GATE 1 — No live imports of worker code from non-worker source: **PASS** (worker-only cluster exception)

`grep` for imports of `services/worker/`, `worker-service`, `worker-spawner`,
`worker-shutdown`, `storage/sqlite`, `services/sqlite`, and the Chroma sync files
from non-worker, non-test source surfaced hits — but tracing the transitive
closure shows they form ONE self-contained worker-only cluster:

```
worker-service.ts → ServerV1Routes.ts → requireServerAuth (middleware/auth.ts)
                                        → sqlite-api-key-service.ts → storage/sqlite
worker-service.ts → WorktreeAdoption.ts → ChromaSync (services/sync)
```

Verified none reach the local/server boot:
- `requireServerAuth` (SQLite auth) is called ONLY by `ServerV1Routes` (lines 62, 67);
  `ServerV1Routes` is imported ONLY by `worker-service.ts:69`.
- `WorktreeAdoption` is imported ONLY by `worker-service.ts:58`.
- The local/server path (`ServerV1PostgresRoutes`) uses `requirePostgresServerAuth`
  (`middleware/postgres-auth.ts`) — a separate auth stack.

Every SQLite + Chroma import is inside the worker subtree. All other grep hits were
comments/strings or the Chroma files' internal self-references.

**Phase-4 delete-list augmentation (discovered here):** `WorktreeAdoption.ts`,
`ServerV1Routes.ts`, `sqlite-api-key-service.ts`, and `middleware/auth.ts` are
worker-only and must be deleted in Phase 4 (they are not in the original plan's
enumerated list but are part of the same cluster).

## GATE 2 — Full suite green with worker unreachable (`MEMSMITH_RUNTIME=local`): **PASS**

Result: **2398 pass / 30 skip / 22 fail**. All 22 residual failures categorized;
ZERO are non-worker-non-preexisting:

- **Worker-only (deleted in Phase 4):** worker-json-status, Worker Self-Spawn CLI,
  CORS Restriction (`tests/worker/middleware/cors-restriction.test.ts`).
- **Pre-existing / test-pollution (project commits touched NONE of their sources):**
  request_id middleware (PASSES 4/0 in isolation → test-ordering pollution, not a
  regression), Logger Usage Standards, spawn-env discipline, adaptObservation
  (server-adapter).

Baseline comparison (detached worktree @ `3fd02989`, pre-project) confirmed the
runtime-selector + install-non-tty stale-contract tests were the ONLY suites failing
because of this project's source changes. Those were updated to the new local-default
contract (commit `354cc5a1`) and are now green. `EmbeddedPostgresManager lifecycle`
fails ONLY when :55433 is held by the live local runtime (environmental collision) —
passes on a free port.

## GATE 3 — Clean-install lands on local + capture/retrieve proven: **PASS**

- Shipped default `MEMSMITH_RUNTIME` resolves to `local`.
- `normalizeRuntime`: unset→local, worker→local, server→server (installer + hook path
  agree on the same runtime).
- Zero worker-runtime writes/offers remain in `install.ts`.
- Live capture proven (Task 10): POST `/v1/events` → agent_event → inline queue →
  Ollama generation → observation written (2789→2790 on a substantive event; a
  trivial event was correctly skipped).
- Live semantic retrieval proven: top hit for "worker retirement" is the T10 migration
  decision observation.

## GATE 4 — Capability-loss ledger accepted (no live non-worker consumer): **PASS**

- `/api/logs` (Console): no consumer outside worker. Drop.
- Observation SSE broadcast (`ObservationBroadcaster`/`SessionEventBroadcaster`): no
  consumer outside worker. Drop.
- FTS-only / Chroma-disabled mode: only references outside worker/sync are the
  `MEMSMITH_CHROMA_ENABLED` settings-key definition + default in
  `SettingsDefaultsManager.ts` (a config knob, not a consumer). The FTS/Chroma logic
  is worker/sync-only. Drop. **Phase-4 note:** remove the now-dead
  `MEMSMITH_CHROMA_ENABLED` settings key.

## GATE PASSED — Phase 4 unblocked.

Deletion may proceed. Carry forward to Phase 4:
1. Delete-list augmentation: `WorktreeAdoption.ts`, `ServerV1Routes.ts`,
   `sqlite-api-key-service.ts`, `middleware/auth.ts` (worker-only cluster from Gate 1).
2. `callWorker` + `workerHttpRequest` in `mcp-server.ts` still service legacy
   worker-backed MCP tools (search/timeline/get_observations/corpus) that POST to a
   worker HTTP endpoint — Phase 4 must delete those tools or repoint them, or MCP
   tools break after worker deletion.
3. Remove the dead `MEMSMITH_CHROMA_ENABLED` settings key.
