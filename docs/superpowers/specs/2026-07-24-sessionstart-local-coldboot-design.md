# SessionStart Local Cold-Boot — Design

**Date:** 2026-07-24
**Status:** Approved (design). Ready for implementation planning.
**Severity:** Critical — a fresh marketplace install of MemSmith never starts the local runtime.

## Problem

A fresh **marketplace** install of MemSmith does not start the local embedded
runtime. Symptoms observed during the P3 manual wizard test (install in a clean
temp project): the plugin shows "enabled" but there is no MCP-connected line, no
"welcome + dashboard" message, no runtime on `:55433`/`:38879`, and no
`.memsmith/project.json` marker minted.

### Root cause (reproduced + confirmed)

The Claude Code SessionStart hook runs `server-service.cjs start` (built from
`src/server/runtime/ServerService.ts`, generated at `scripts/build-hooks.js:85`
via `claudeHook(['start'])`). That bundle's `start` command handles **only the
server runtime**:

- `runServerServiceCli`'s `start` case → `runServerForeground` →
  `createServerService` → `validateServerEnv`, which **hard-requires**
  `MEMSMITH_SERVER_DATABASE_URL` (`create-server-service.ts:137-139`).
- In local mode (no remote URL) this throws
  `"MEMSMITH_SERVER_DATABASE_URL is required to start the server"` and boots
  nothing. Reproduced by running the exact hook command from the temp project.

The embedded-PG boot logic (`startLocalRuntime` /`EmbeddedPostgresManager`) lives
in `src/server/runtime/local-runtime.ts`, dispatched only by the separate
`src/services/local-runtime-cli.ts` (`local start`) — which is **bundled into
none** of the three shipped `.cjs` files (`grep` for
`startLocalRuntime`/`EmbeddedPostgresManager` in the shipped `server-service.cjs`
= 0). So the marketplace bundle physically cannot cold-boot local.

The only local cold-boot path is `npx-cli/commands/install.ts:1705`, which spawns
a detached `worker-service.cjs local start` — but `worker-service.cjs` is retired
and not in the bundle, and `npx install` does not run on a marketplace install.

The dogfood works only because it was hand-started long ago; the SessionStart
hook's `start` merely **reuses** the running process via the pid-file
early-return (`ServerService.ts:382-385`). The July-14 "cold-boot acceptance"
booted via a `/tmp/coldboot.mjs` wrapper that imports `startLocalRuntime`
directly — it never exercised the real `server-service.cjs start` hook path, so
this gap was never covered.

## Goal

The zero-friction customer flow must work: **install (marketplace) → open a
Claude session → the runtime self-boots** (embedded PG + server loop + marker
mint + welcome/dashboard), with no extra command. No `npx install`, no manual
`local start`, no env juggling.

## Approach

Make `server-service.cjs`'s `start` command **runtime-aware**. When `start` runs
and no server is already running, consult `selectRuntime(cwd)` and branch:

- **`local`** → boot the embedded runtime via `startLocalRuntime()` (embedded PG
  → first-run import → server foreground loop; `resolveLocalScope` mints the
  `.memsmith` marker + team key as it already does). This is the exact code path
  the July-14 acceptance proved works — we are shipping it in the bundle and
  wiring it to the hook.
- **`server`** → the current behavior (validate `MEMSMITH_SERVER_DATABASE_URL`,
  run server foreground).

The existing "reuse running server" early-return stays first, so an
already-running instance (e.g. the dogfood) is never double-booted.

### Why this is the right layer

- `selectRuntime(cwd)` already exists and is per-project marker-aware (sub-spec
  1): a project that has gone team resolves `server`; a local project resolves
  `local`. The `start` branch inherits that for free.
- `EmbeddedPostgresManager` imports only `fs`/`os`/`path` (no bun-only modules),
  and the hook already runs the bundle under **bun** (`bun-runner.js`), so
  bundling the local-boot code is safe and adds no new runtime constraint.
- The change is contained to the `start` dispatch; the hook command, build
  config, pid/reuse logic, and server-mode path are unchanged.

## Components / change points

1. **`src/server/runtime/ServerService.ts` — `runServerServiceCli` `start` case.**
   After the reuse early-return, resolve `selectRuntime(cwd)`; if `local`, call
   `startLocalRuntime()` (foreground; blocks like the server loop). Otherwise keep
   the existing server foreground path. `cwd` = `process.env.MEMSMITH_PROJECT_CWD
   ?? process.cwd()` (matching how the rest of the runtime resolves the project).
   `--daemon` and `restart` inherit the same branch (they funnel through the same
   start logic), so a local install can also daemonize correctly.

2. **Bundle inclusion (`scripts/build-hooks.js`).** No config change expected —
   importing `startLocalRuntime` from `ServerService.ts`'s `start` path pulls
   `local-runtime.ts` + `EmbeddedPostgresManager` into the `server-service` bundle
   automatically. The build's existing bun-only-import guards apply to
   `mcp-server.cjs` (Node), NOT `server-service.cjs` (bun) — so this is allowed. A
   build-time assertion will confirm the shipped bundle now contains the local
   boot symbols (guards against silent tree-shaking / regression).

3. **No change** to: the hook templates, `ConvertRoutes`, the wizard, the
   per-project runtime resolution, or `local-runtime-cli.ts` (it may remain as the
   explicit `local start` CLI; this fix just gives `start` the same capability the
   hook actually invokes).

## Data flow (after fix)

```
marketplace install → open Claude session
  → SessionStart hook: bun-runner server-service.cjs start
      → reuse? running server on port → return "ready"           (unchanged)
      → else selectRuntime(cwd):
          local  → startLocalRuntime()                            (NEW)
                     → EmbeddedPostgresManager.start() (:55433)
                     → first-run import + resolveLocalScope
                        (mints .memsmith marker + team key)
                     → runServerForegroundForLocal() (:38879)
          server → validate DB URL → runServerForeground()        (unchanged)
  → SessionStart.0.1 hook: `hook claude-code context`
      → now reaches a running local runtime → welcome + dashboard link
```

## Error handling

- Port already held by a **foreign** process: `EmbeddedPostgresManager.start`
  already fails loud (`":55433 is in use by another process"`) — preserved.
- Reuse path unchanged: a running server short-circuits before any boot.
- Local boot failure (e.g. bun/PG binaries missing): surfaces as the hook's
  stderr; the hook still emits its trailing `{"continue":true}` so the session is
  not blocked (matches current hook contract).
- Server-mode misconfig (no DB URL) still throws its existing clear error.

## Testing

1. **Unit — `start` dispatch is runtime-aware:** with `selectRuntime` stubbed to
   `local` and a stub `startLocalRuntime`, invoking the `start` command (nothing
   running) calls `startLocalRuntime`, NOT the server foreground/validate path.
   With `selectRuntime` → `server`, it takes the server path (validate DB URL).
2. **Unit — reuse still wins:** with a running-server pid stub, `start` returns
   "ready" and calls neither boot path (regardless of `selectRuntime`).
3. **Build assertion:** the shipped `server-service.cjs` contains the local-boot
   symbols (`startLocalRuntime` / `EmbeddedPostgresManager`) — a `grep`-style
   check in `build-hooks.js` that fails the build if absent (prevents silent
   regression to the current broken state).
4. **Integration (self-skipping):** a test that runs the real `start` command in
   `local` mode against a throwaway `MEMSMITH_DATA_DIR` + free PG port and asserts
   the embedded PG + server come up and a marker is minted. Self-skips when the
   embedded PG binaries / a free port are unavailable (same idiom as the existing
   PG-gated tests). MUST refuse to run against `~/.memsmith` / `:55433` (dogfood
   guard).
5. **Manual acceptance = P3 itself:** re-install in the temp project → session
   self-boots → welcome + dashboard appear → run the Go Team wizard.

## Global constraints

- Branch from `main` (`f457d86b`). Never commit to `main`. Merge `--no-ff`
  recording a pre-merge rollback SHA. Nothing pushed (local only).
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood must never be at risk.** Tests use throwaway `MEMSMITH_DATA_DIR` +
  non-`:55433` ports only; the dogfood guard (refuse `~/.memsmith` / `:55433`)
  is a hard precondition in any integration test.
- Rebuild + sync the marketplace bundle (`npm run build-and-sync`) is part of the
  deliverable — the fix only takes effect once the shipped `.cjs` contains the
  local-boot code. (The build must NOT auto-relaunch/kill the running dogfood; if
  it does, that is handled out-of-band by the operator, not the test.)
- No new schema/migration; no dependency changes.
- Sonnet implementers + per-task review + broad Opus review, per standing
  instruction.

## Open follow-ups (out of scope here)

- The July-14 acceptance tested a wrapper, not the hook — add the real-hook
  integration test (Testing #4) so this can't silently regress again.
- The dogfood restarted in `api-key` auth mode during P3 recovery (cosmetic;
  keyless dashboard 403s). Not part of this fix; note for a separate cleanup.
