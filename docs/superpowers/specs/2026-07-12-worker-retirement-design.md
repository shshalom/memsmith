# Worker Retirement Design

**Status:** Approved design (2026-07-12). Precedes the implementation plan.

**Branch:** `embedded-pg-local-runtime` (nothing pushed; no merge to main in scope).

## Goal

Local users get the embedded (Postgres + pgvector) runtime end-to-end — install,
config, hooks, and plugin all default to it — and the legacy `worker` runtime plus
its SQLite/Chroma stack is deleted, once a mechanical safety gate proves nothing
outside the worker depends on it.

## Why now

GAP1 is closed: on the same model, the embedded path's single-shot generation
scores at least as well as the worker's multi-turn path (4.32 vs 3.85 overall — the
extra turns produced more low-value observations, not better ones; see
`bench/GAP-FINDINGS.md`). Semantic retrieval via pgvector beats the worker's keyword
search on the live corpus (8/8 vs 2/8). The quality argument for keeping the worker
is gone. The real driver is forward: we do not want to carry a second runtime's
assumptions into the upcoming identity and AWS work.

## Background: the three runtimes today

- `worker` — legacy claude-mem path: SQLite store, Chroma vector sync, multi-turn
  generation, self-supervised daemon. The **shipped default**.
- `server` — remote Postgres + BullMQ. For teams.
- `local` — embedded Postgres (in-process, no Docker) on :55433 via
  `startLocalRuntime()`. Boots the SAME `createServerService` code path as `server`;
  differs only in DB target (embedded vs remote) and queue engine (inline vs BullMQ).

After retirement there are **two** runtimes: `local` (embedded, in-process — the
default for solo users) and `server` (remote — for teams). `worker` ceases to exist.
The default flips `worker → local`. This matches the north-star: one engine; local
boots it embedded, teams point it remote.

## Data status

Already migrated. The live corpus (2789 observations) is in the embedded Postgres,
via the first-boot SQLite→Postgres import and a one-shot sync
(`scripts/sync-worker-to-pg.mjs`). No re-migration is required. A user flipping to
`local` who still has a worker SQLite DB gets it imported on first embedded boot
(taxonomy-aware, idempotent, with embedding backfill) — existing behavior, not new
work.

## Architecture: four phases, one plan

Each phase is an independently reviewable and revertible commit. Phase 4 (delete)
proceeds only if Phase 3 (verify) passes. Deletion is gated, never a guess.

| Phase | What | Behavior change | Risk |
|---|---|---|---|
| 1. Sever | Decouple non-worker code from worker code | None | Low |
| 2. Flip + wire | Make `local` the wired-in default everywhere | Yes — new installs land on embedded | Highest |
| 3. Verify safe | Mechanical gate proving worker is unreachable-safe | None (gate) | — |
| 4. Delete | Remove ~18K LOC of worker/SQLite/Chroma code | Worker unreachable | Medium |

---

## Phase 1 — Sever couplings

Behavior-preserving decoupling so worker code can be deleted later without breaking
non-worker code. Three known couplings; Phase 1 also pulls forward the SQLite-auth
check that Phase 4 depends on.

1. **`getOllamaConfig`** — `src/server/runtime/import/ollamaClassifier.ts:6` imports
   `getOllamaConfig` from `src/services/worker/OllamaProvider.ts`. Extract the pure
   config-loading logic (OllamaProvider.ts ~249–261) to `src/shared/ollama-config.ts`;
   repoint both the classifier and OllamaProvider at the shared module.

2. **`local` CLI lifecycle** — `worker-service.ts:827` hosts the
   `local start|stop|status` command (and the `MEMSMITH_RUNTIME=local` boot at ~1239).
   This must SURVIVE worker deletion. Extract the `local` command handling into its
   own module (e.g. `src/services/local-runtime-cli.ts`) that does not depend on any
   worker-only code. `worker-service.ts` itself is deleted in Phase 4.

3. **Spawner references** — `src/npx-cli/commands/install.ts` and
   `src/servers/mcp-server.ts:24` import `ensureWorkerStarted` from
   `services/worker-spawner.js`. These are addressed in Phase 2 (repointed to the
   embedded-runtime boot), not Phase 1.

4. **SQLite-auth check (pulled forward from Phase 4).** `sqlite-api-key-service.ts`
   uses `src/storage/sqlite/`. Before Phase 4 can delete the SQLite stores, confirm
   whether the embedded/server path reuses any SQLite module (auth or otherwise). If
   it does, that module moves to a neutral location or stays; it is not deleted
   blindly. Determine this in Phase 1 so Phase 4 has no surprises.

**Verification:** existing tests stay green; no behavior change.

---

## Phase 2 — Flip + wire the default (highest risk)

Every touch point that determines what runtime a user lands on.

**A. Shipped default.** `src/shared/SettingsDefaultsManager.ts:171` —
`MEMSMITH_RUNTIME: 'worker'` → `'local'`.

**B. Runtime selector.** `src/services/hooks/runtime-selector.ts:39–46`.
- Today `selectRuntime()` maps `server`/`server-beta`→`server` and **everything else
  → `worker`** (the trap: an unset/legacy value falls to a runtime we're deleting).
- New behavior: `server`/`server-beta`→`server`; **`worker`→`local` (smooth legacy
  remap)**; everything else→`local`.
- `resolveRuntimeContext()` (100–109): the `worker` branch becomes a `local` branch
  that boots/points at the embedded runtime.

**Legacy remap decision (approved):** an existing user with an explicit
`MEMSMITH_RUNTIME=worker` is silently remapped to `local` at Phase 2. This is
correct — their data already lives in embedded PG — and avoids a hard error at
Phase 4. Documented in the changelog/migration note.

**C. Installer.** `src/npx-cli/commands/install.ts` stops writing
`MEMSMITH_RUNTIME: 'worker'`. New installs write `local` explicitly (or write nothing
and inherit the new default). `ensureWorkerStarted()` calls become
`ensureLocalRuntimeStarted()` (embedded boot, using the Phase 1 `local` CLI module).

**D. MCP server lazy-spawn.** `src/servers/mcp-server.ts:24` — `ensureWorkerStarted`
→ the embedded-runtime equivalent.

**E. Plugin hook routing.** Remove worker dispatch branches from
`plugin/hooks/hooks.json` and the `.claude-plugin` / `.codex-plugin` manifests; hooks
route to embedded. **Rebuild the plugin** (`scripts/build-hooks.js` → `plugin/`) so
shipped artifacts match source.

**F. Developer's live machine (approved).** Update `~/.memsmith/settings.json`
`server`→`local` (back up first). Because `local` boots embedded PG in-process on
:55433 (rather than the standalone server on :37879), cleanly stop the running
standalone server as part of the switch. Same Postgres data either way.

**Verification:** existing tests stay green; add a test asserting the resolved
default is `local` and that legacy `worker` remaps to `local`.

---

## Phase 3 — Verify safe-to-delete (the gate)

Phase 4 proceeds only if ALL gates pass. Each is mechanical and re-runnable. The
output is a short pass/fail checklist committed to the repo, so "we verified it was
safe" is a recorded artifact.

**Gate 1 — No live imports of worker code.** Grep every non-worker source file for
imports from `src/services/worker/`, `src/services/worker-service`,
`src/services/worker-spawner`, `src/services/worker-shutdown`, `src/storage/sqlite/`,
`src/services/sqlite/`, and the Chroma files in `src/services/sync/`. After Phase 1,
this must return **zero** hits outside worker-owned files and their own tests. Any
hit is a missed coupling → fix before deleting.

**Gate 2 — Full suite green with worker unreachable.** Run the suite with
`MEMSMITH_RUNTIME=local`. Worker tests still exist here (they are deleted in
Phase 4, not Phase 3), so exclude the worker-specific test files via a test-runner
path filter — do not delete them yet — and require everything else green. Proves the
embedded path stands alone.

**Gate 3 — Clean-install E2E on embedded only.** From a scratch temp `MEMSMITH_HOME`:
run the installer → confirm it lands on `local` → boot embedded → fire a capture
event through the hook path → confirm an observation lands in embedded PG → run a
retrieval query and get it back. Proves a brand-new user works without the worker.

**Gate 4 — Capability-loss ledger accepted.** The three genuine worker-only losses,
each with an explicit disposition (all approved to drop):
- **`/api/logs` (Console)** — already hidden in the UI; confirm no other live
  consumer. Drop.
- **Observation SSE broadcast** — the embedded path's poll-based `/api/observations`
  is sufficient; confirm no consumer depends on push. Drop.
- **FTS-only mode** (Chroma-disabled SQLite search) — embedded uses pgvector hybrid
  (FTS+vector) always; the pure-FTS toggle goes away. Drop.

If any of the three has a live consumer, it is re-scoped before deletion, not
silently dropped.

**Capabilities confirmed NOT lost** (duplicated in embedded, verified during
exploration): Ollama generation (`OllamaObservationProvider`), semantic search
(pgvector `vectorSearch`/`hybridSearch`), and the `local start|stop|status` CLI
(extracted in Phase 1). Chroma is redundant, not lost — pgvector replaces it.

---

## Phase 4 — Delete (~18K LOC), gated on Phase 3

Delete in dependency order (leaf consumers → stores → build wiring). Rebuild the
plugin. After each deletion batch, re-run Gate 1 (grep) + the suite, so a dangling
import surfaces at the batch that caused it.

| Category | Paths |
|---|---|
| Worker core | `src/services/worker/`; `src/services/worker-service.ts` (minus the Phase 1 `local` CLI extraction); `src/services/worker-spawner.ts`; `src/services/worker-shutdown.ts` |
| SQLite stores | `src/storage/sqlite/`, `src/services/sqlite/` — minus any module Phase 1 determined the embedded path still uses |
| Chroma sync | Chroma files in `src/services/sync/` (`ChromaSync`, `ChromaMcpManager`, `ChromaSyncState`) |
| Worker tests | `tests/worker-*.test.ts`, `tests/services/worker-*.test.ts`, `tests/integration/worker-api-endpoints.test.ts`, worker util tests under `tests/shared/` |
| Build targets | `WORKER_SERVICE` in `scripts/build-hooks.js`; `build:binaries` / `build:cli-binary` in `package.json`; `worker:restart` from the `build-and-sync` script |
| Plugin scripts | `plugin/scripts/worker-service.cjs`, `worker-cli.js`, `worker-wrapper.cjs` |

**Verification:** suite green minus the deleted worker tests; plugin rebuilds clean;
Gate 1 returns zero.

---

## Testing strategy (whole project)

- Phases 1 & 2: existing tests stay green (decoupling + flip are behavior-preserving
  except the default value, which gets a dedicated test: resolved default is `local`,
  legacy `worker` remaps to `local`).
- Phase 3: the gate itself is the test; result committed as a checklist artifact.
- Phase 4: suite green minus deleted worker tests; plugin rebuild clean; Gate 1 zero.

## Rollback

Each phase is its own commit on `embedded-pg-local-runtime`. Reverting the Phase 4
commit(s) restores the worker verbatim. Nothing is pushed. The Phase 2 live-settings
backup restores the developer machine to `server` instantly if embedded-in-process
misbehaves.

## Out of scope (YAGNI)

- Building any NEW server-side replacement for dropped capabilities (no SSE, no logs
  API, no FTS-only toggle).
- The identity / AWS work this unblocks.
- Any push or merge to `main`.

## Security / operational constraints (carried from prior context)

- Nothing is pushed; local clone only.
- Never rename keep-list deps (`claude-code` / `claude-agent` / `@anthropic-ai`).
- Local-dev bypass env (`MEMSMITH_LOCAL_DEV_TEAM_ID/PROJECT_ID`) is valid only on
  loopback + local-dev + bypass; never production/Docker.
- Git commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
