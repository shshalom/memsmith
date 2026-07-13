# SQLite Reuse Audit — Phase 4 Prerequisite

**Date:** 2026-07-12  
**Branch:** embedded-pg-local-runtime  
**Auditor:** Claude (Task 3)  
**Status:** FINAL — feeds Phase 4 deletion plan

---

## Step 1 — Grep Output

Command run:
```
grep -rn "storage/sqlite\|services/sqlite" src/ --include="*.ts" \
  | grep -v "src/services/worker" \
  | grep -v "src/services/sqlite" \
  | grep -v "src/storage/sqlite" \
  | grep -v ".test.ts"
```

Raw output (two hits):
```
src/server/auth/sqlite-api-key-service.ts:10:import { AuthRepository, ensureServerStorageSchema } from '../../storage/sqlite/index.js';
src/server/routes/v1/ServerV1Routes.ts:17:} from '../../../storage/sqlite/index.js';
```

`src/services/sqlite/` has **zero** non-worker, non-self imports in `src/`. All references to `services/sqlite/*` modules come from `src/services/worker/` subtree or from `src/services/context/` and `src/services/sync/` — both of which are only consumed by `services/worker/` routes and `worker-service.ts`.

---

## Step 2 — Per-Module Verdicts

### `src/storage/sqlite/` modules

All `src/storage/sqlite/` modules are exported through a single barrel (`index.ts`). The barrel itself is not on the embedded/server path. Two files outside the worker subtree import from it — their verdicts follow.

#### Hit 1: `src/server/auth/sqlite-api-key-service.ts` → `src/storage/sqlite/index.js`
- **Importer file:line:** `src/server/auth/sqlite-api-key-service.ts:10`
- **Symbols imported:** `AuthRepository`, `ensureServerStorageSchema`
- **What it does:** Provides `createServerApiKey`, `verifyServerApiKey`, `listServerApiKeys`, `revokeServerApiKey`, `migrateServerApiKeyScopes` — a full SQLite-backed API-key CRUD service operating on a `bun:sqlite` `Database` handle.
- **Who calls it:**
  - `src/server/middleware/auth.ts:5` imports `verifyServerApiKey` — this is the **`requireServerAuth` middleware** used by `ServerV1Routes` (the SQLite-backed HTTP server).
  - `src/services/worker-service.ts:68` imports `createServerApiKey`, `listServerApiKeys`, `revokeServerApiKey`, `migrateServerApiKeyScopes`, `DEFAULT_LOCAL_API_KEY_SCOPES` — all for the **worker CLI** (`worker-service api-key create/list/revoke/migrate`).
- **Does the embedded/local path (`createServerService` → `ServerService`) call it?**  
  No. `createServerService` (`src/server/runtime/create-server-service.ts`) builds a `ServerService` that registers `ServerV1PostgresRoutes` (line 184) and `requirePostgresServerAuth` (`src/server/middleware/postgres-auth.ts`). The embedded runtime calls `runServerForegroundForLocal` → `runServerForeground` → `createServerService`. Neither path touches `sqlite-api-key-service.ts` or `requireServerAuth` (the SQLite auth middleware). The Postgres runtime has its own completely separate auth path (`src/server/middleware/postgres-auth.ts` + `src/storage/postgres/auth.ts`).
- **Verdict:** **`delete`** — this module and its importer `src/server/middleware/auth.ts` are exclusively consumed by the worker runtime (`worker-service.ts`) and `ServerV1Routes` (also worker-only — see Hit 2). Safe to remove in Phase 4.

#### Hit 2: `src/server/routes/v1/ServerV1Routes.ts` → `src/storage/sqlite/index.js`
- **Importer file:line:** `src/server/routes/v1/ServerV1Routes.ts:17`
- **Symbols imported:** `AgentEventsRepository`, `AuthRepository`, `MemoryItemsRepository`, `ProjectsRepository`, `ServerSessionsRepository`
- **What it does:** Mounts all `/v1/` REST routes (projects, sessions, events, memories, search, context, audit) backed by SQLite repositories.
- **Who registers it:**
  - `src/services/worker-service.ts:363` — the only call site. The embedded/local runtime (`ServerService.setupRoutes`) registers `ServerV1PostgresRoutes` (line 184 of `ServerService.ts`), not `ServerV1Routes`.
- **Does the embedded/local path call it?**  
  No. `ServerService.ts` imports only `ServerV1PostgresRoutes` (line 19). `ServerV1Routes` is never imported by `ServerService.ts`, `create-server-service.ts`, or `local-runtime.ts`.
- **Verdict:** **`delete`** — worker-only. Safe to remove in Phase 4.

---

### `src/storage/sqlite/` individual module verdicts

All modules are barrel-exported via `index.ts`. Their only non-worker consumers are `sqlite-api-key-service.ts` (worker-only auth helper) and `ServerV1Routes.ts` (worker-only route handler), both of which are themselves `delete`.

| Module | Verdict | Rationale |
|--------|---------|-----------|
| `src/storage/sqlite/index.ts` | **delete** | Barrel for worker-only modules |
| `src/storage/sqlite/auth.ts` | **delete** | Imported via index; used only by `sqlite-api-key-service.ts` and `ServerV1Routes.ts` |
| `src/storage/sqlite/agent-events.ts` | **delete** | Imported via index; used only by `ServerV1Routes.ts` |
| `src/storage/sqlite/memory-items.ts` | **delete** | Imported via index; used only by `ServerV1Routes.ts` |
| `src/storage/sqlite/projects.ts` | **delete** | Imported via index; used only by `ServerV1Routes.ts` |
| `src/storage/sqlite/server-sessions.ts` | **delete** | Imported via index; used only by `ServerV1Routes.ts` |
| `src/storage/sqlite/schema.ts` | **delete** | Provides `ensureServerStorageSchema`; used only by `sqlite-api-key-service.ts` |
| `src/storage/sqlite/serde.ts` | **delete** | Used only within the `src/storage/sqlite/` sibling modules |

---

### `src/services/sqlite/` modules

All modules in this subtree are consumed exclusively through the worker path. The complete import chain:

- `src/services/sqlite/SessionStore.ts` → imported by:
  - `src/services/worker/DatabaseManager.ts:3` (worker-only)
  - `src/services/context/ContextBuilder.ts:5` — which is re-exported through `src/services/context-generator.ts` and consumed only by `src/services/worker/http/routes/SearchRoutes.ts:261,317` (worker-only)
  - `src/services/context/ObservationCompiler.ts:4` — consumed only by `src/services/worker/http/routes/SearchRoutes.ts:12` (worker-only)
  - `src/services/sync/ChromaSync.ts:11` (type-only import) — consumed by `src/services/worker/DatabaseManager.ts`, `src/services/worker-service.ts`, and other `services/worker/` subtrees
- `src/services/sqlite/SessionSearch.ts` → imported only by `src/services/worker/DatabaseManager.ts:4`
- `src/services/sqlite/observations/files.ts` → imported by `src/services/sync/ChromaSync.ts:22` (worker-only consumer chain above)
- `src/services/sqlite/observations/get.ts`, `store.ts`, `recent.ts` → consumed within the `services/sqlite/` subtree itself or by `services/worker/`
- `src/services/sqlite/prompt-storage.ts`, `prompts/get.ts` → no non-worker consumers found
- `src/services/sqlite/types.ts` → used only within `services/sqlite/` and `services/worker/`

The embedded/server path (`createServerService`, `ServerService`, `local-runtime.ts`) never imports any `services/sqlite/` module. The `local-runtime.ts` first-run import reads the worker SQLite DB via `src/server/runtime/import/sqliteReader.ts`, which uses `bun:sqlite` directly — not the `services/sqlite/` abstraction layer.

| Module | Verdict | Rationale |
|--------|---------|-----------|
| `src/services/sqlite/SessionStore.ts` | **delete** | Worker + worker-context chain only |
| `src/services/sqlite/SessionSearch.ts` | **delete** | Worker only (DatabaseManager) |
| `src/services/sqlite/observations/files.ts` | **delete** | ChromaSync (worker) only |
| `src/services/sqlite/observations/get.ts` | **delete** | Worker only |
| `src/services/sqlite/observations/store.ts` | **delete** | Worker only |
| `src/services/sqlite/observations/recent.ts` | **delete** | Worker only |
| `src/services/sqlite/prompt-storage.ts` | **delete** | Worker only |
| `src/services/sqlite/prompts/get.ts` | **delete** | Worker only |
| `src/services/sqlite/types.ts` | **delete** | Worker only |

---

### Server-adjacent files that import `sqlite-api-key-service.ts` (not in scope but noted for completeness)

- `src/server/middleware/auth.ts` — imports `verifyServerApiKey`; used only by `ServerV1Routes` (worker-only). **delete**
- `src/server/auth/sqlite-api-key-service.ts` — imports `storage/sqlite/index`; consumed only by worker-service and auth.ts. **delete**

---

## Summary

| Directory | Modules | Verdict |
|-----------|---------|---------|
| `src/storage/sqlite/` | 8 files | All **delete** |
| `src/services/sqlite/` | 9 files (+ 1 sub-dir) | All **delete** |
| `src/server/auth/sqlite-api-key-service.ts` | 1 file | **delete** |
| `src/server/middleware/auth.ts` | 1 file | **delete** |
| `src/server/routes/v1/ServerV1Routes.ts` | 1 file | **delete** |

**Total: 20 files — all `delete`, 0 `move`, 0 `keep-in-place`.**

The embedded/local runtime (`MEMSMITH_RUNTIME=local`) boots via `startLocalRuntime` → `runServerForegroundForLocal` → `createServerService` → `ServerService.setupRoutes`. This path exclusively uses:
- `src/storage/postgres/` for data storage
- `src/server/middleware/postgres-auth.ts` for authentication
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` for HTTP routes

No `storage/sqlite/` or `services/sqlite/` module is reachable from this path.

---

## Phase 4 Action Plan

Phase 4 can delete all of the above in a single step with no relocations required. Suggested deletion order (leaf-to-root to avoid dangling imports):

1. `src/server/middleware/auth.ts`
2. `src/server/auth/sqlite-api-key-service.ts`
3. `src/server/routes/v1/ServerV1Routes.ts`
4. `src/storage/sqlite/` (entire directory)
5. `src/services/sqlite/` (entire directory)
6. `src/services/context/ContextBuilder.ts`, `ObservationCompiler.ts` (SQLite-coupled context helpers — verify no postgres path uses them first)
7. `src/services/context-generator.ts` (re-export shim for above)

Step 6–7 require verifying that `src/services/context/` has no postgres-path consumer before deletion; the current audit found none.
