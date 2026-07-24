# `start` Auto-Daemonizes for Local — Design

**Date:** 2026-07-24
**Status:** Approved (design). Ready for implementation planning.
**Severity:** Critical — completes the fresh-install cold-boot fix; without it the local
runtime boots but does not persist.

## Problem

After the SessionStart-local-cold-boot fix (merged `308aeef0`), a fresh local install's
SessionStart hook now *reaches* the local boot path — the welcome message appears — but
the runtime does **not persist**: the dashboard is unreachable and nothing listens on
`:55433`/`:38879`.

### Root cause (reproduced + confirmed)

The Claude Code SessionStart hook runs **bare** `start` (`build-hooks.js:85`,
`claudeHook(['start'])` — no `--daemon`). In `runServerServiceCli`'s `start` case, bare
`start` takes the **foreground** path → `runRuntimeForeground` → (local)
`startLocalRuntime`, which **blocks forever** in the server loop
(`runServerForegroundForLocal` → `await new Promise(() => {})`).

A SessionStart hook is a short-lived command with a 60s timeout — it cannot host a
blocking server process. So the local runtime boots inside the hook, then is killed when
the hook times out / returns; nothing persists. This is why the dogfood always worked:
it was launched **detached** (`nohup`/`setsid`; `install.ts` uses `spawn` with
`detached:true`), never via the blocking foreground hook.

The prior fix made `start` *able* to boot local; it did not make the *hook invocation*
detach. That is this fix.

**Correction to an earlier hypothesis:** an initial diagnosis suspected
`spawnServerDaemon` strips `MEMSMITH_PROJECT_CWD` from the detached child. Verified
FALSE — `sanitizeEnv` (`src/supervisor/env-sanitizer.ts`) strips only
`CLAUDE_CODE_*`/`CLAUDECODE_*` prefixes and a fixed proxy/session denylist; every other
key (including `MEMSMITH_PROJECT_CWD`) passes through. So the child already inherits it.
This fix still sets it explicitly on the child as belt-and-suspenders (see D2).

## Goal

A fresh local install self-boots a **persistent** runtime on the first Claude session:
the SessionStart hook returns immediately while a detached process keeps the embedded PG
+ server alive. `install → open session → welcome + dashboard reachable`, no extra step.
Server/team-mode behavior is unchanged.

## Approach

Make the `start` command **auto-daemonize when the resolved runtime is local**. In the
`start` case, after the existing "reuse running server" early-return, take the detached
`spawnServerDaemon` path when EITHER `--daemon` was requested (existing behavior) OR
`selectRuntime(cwd) === 'local'` (new). Otherwise keep the server-mode foreground path.

The detached child runs `[scriptPath, '--daemon']` → the `--daemon` case →
`runRuntimeForeground` (already runtime-aware from the prior fix) → boots local. The
parent hook returns immediately with `{status:'starting'}` and does not block.

### Why this is the right layer

- Local runtime has ALWAYS needed to run detached (that is how the dogfood and the
  `npx install` path launch it). Making local `start` detach by default codifies that
  invariant in the one place `start` decides foreground-vs-detached.
- **Server-mode is untouched.** `#2444` deliberately made server `start` foreground by
  default (systemd `Type=simple` owns the PID/restart policy). The new branch keys on
  `selectRuntime === 'local'`, so server/team installs keep foreground behavior exactly.
- The reuse early-return stays first, so a running instance (e.g. the dogfood) is never
  double-booted or port-collided.
- `spawnServerDaemon` + the `--daemon` re-entry path already exist and (post prior fix)
  already boot local correctly — this fix only changes *which* path bare local `start`
  chooses.

## Decisions

### D1 — Local `start` auto-detaches

```
case 'start':
  reuse-check → return "ready"                      (unchanged; first)
  const wantsDaemon = startCommandWantsDaemon(argv.slice(1))
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd()
  const isLocal = selectRuntime(cwd) === 'local'
  if (wantsDaemon || isLocal) {
    const daemonPid = spawnServerDaemon(port)
    ... existing failure handling + {status:'starting'} log ...
    return
  }
  await runRuntimeForeground(port, host)             (server-mode foreground; unchanged)
```

`selectRuntime` is imported already (prior fix). The `isLocal` resolution uses the same
`cwd` rule as `runRuntimeForeground` so foreground and detach agree on the runtime.

### D2 — `spawnServerDaemon` sets `MEMSMITH_PROJECT_CWD` explicitly

The detached child must resolve the SAME project as the parent. It already inherits
`MEMSMITH_PROJECT_CWD` via `sanitizeEnv` passthrough, but that is an implicit dependency
on the sanitizer's allowlist behavior. Set it explicitly on the child env alongside the
existing `MEMSMITH_SERVER_PORT`:

```
env: {
  ...sanitizeEnv(process.env),
  MEMSMITH_SERVER_PORT: String(port),
  MEMSMITH_PROJECT_CWD: process.env.MEMSMITH_PROJECT_CWD ?? process.cwd(),
}
```

This removes the hidden dependency and guarantees the child boots the right project even
if the sanitizer denylist changes later.

### D3 — No hook / build-manifest change

The SessionStart hook stays `claudeHook(['start'])`. The behavior change lives entirely
in the `start` command, so the hook manifest, `verifyShellTemplateCanonical` drift
check, and Codex hooks are untouched. (The alternative — changing the hook to
`start --daemon` — was rejected: it would force server-mode installs to daemonize on
SessionStart too, a behavior change, and would touch the manifest + drift checks.)

## Components / change points

1. `src/server/runtime/ServerService.ts` — `start` case: add the `isLocal` branch (D1).
2. `src/server/runtime/ServerService.ts` — `spawnServerDaemon`: add explicit
   `MEMSMITH_PROJECT_CWD` on the child env (D2).
3. **No change** to: the hook templates / `build-hooks.js`, `runRuntimeForeground`
   (prior fix), `startLocalRuntime`, `runServerForegroundForLocal`, or server-mode.

## Data flow (after fix)

```
fresh local install → open Claude session
  → SessionStart hook: server-service.cjs start
      → reuse? running server → "ready"                       (unchanged)
      → else selectRuntime(cwd)==='local' → spawnServerDaemon(port) → {status:'starting'}
           parent RETURNS immediately (hook completes, no block)
           detached child: --daemon case → runRuntimeForeground → startLocalRuntime
             → embedded PG (:55433) + import + marker mint + server loop (:38879)
             (child keeps running after the hook returns — PERSISTENT)
  → SessionStart.0.1 hook `context` → reaches the now-persistent runtime → welcome + dashboard
  → dashboard :38879 reachable ✓
```

## Error handling

- `spawnServerDaemon` returning `undefined` → existing `console.error` + `process.exit(1)`
  (unchanged).
- Detached child boot failure (PG binaries missing, port held by a foreign process) →
  the child logs + exits; the parent already returned `{status:'starting'}`. The next
  `context` hook / dashboard load surfaces "not running" — same failure visibility as any
  detached daemon. (A future enhancement could poll for readiness; out of scope.)
- Reuse early-return unchanged — a running server short-circuits before the runtime
  branch, so no double-boot.
- Server-mode misconfig (no DB URL) still surfaces via the foreground path's existing
  `validateServerEnv` error (server installs don't hit the detach branch).

## Testing

1. **Unit — local auto-detaches:** in the `start` case with `selectRuntime` stubbed to
   `local`, no running server, and `spawnServerDaemon` stubbed: assert the daemon-spawn
   path is taken (spawn called, returns `{status:'starting'}`) and the blocking
   foreground `runRuntimeForeground` is NOT awaited.
2. **Unit — server stays foreground:** `selectRuntime → server`, bare `start` (no
   `--daemon`): assert foreground path taken, `spawnServerDaemon` NOT called.
3. **Unit — explicit `--daemon` still daemonizes** (both runtimes): unchanged behavior.
4. **Unit — reuse still wins:** running-server pid stub → returns "ready", neither
   detach nor foreground path entered (regardless of runtime).
5. **Unit — `spawnServerDaemon` env:** the child env includes `MEMSMITH_PROJECT_CWD`
   (D2) and `MEMSMITH_SERVER_PORT`.
6. **Integration (existing, opt-in):** the `local-coldboot-integration` test already
   proves `startLocalRuntime` boots a throwaway PG; this fix does not alter that path.
   (The persistence is a process-lifetime property best proven by the manual P3
   acceptance, below.)
7. **Manual acceptance = P3:** fresh session in the temp project → welcome appears AND
   dashboard `:38879` (temp project's port) is reachable and stays up → run the Go Team
   wizard.

## Global constraints

- Branch from `main` (`308aeef0`). Never commit to `main`. Merge `--no-ff` recording a
  pre-merge rollback SHA. Nothing pushed (local only).
- Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood must never be at risk.** Unit tests stub `spawnServerDaemon` /
  `selectRuntime` (no real spawn, no real PG). No test spawns a detached process against
  `~/.memsmith` / `:55433`.
- Rebuild + sync the marketplace bundle (`npm run build-and-sync`) is the final task, so
  the shipped `server-service.cjs` carries the auto-detach. The build must not
  kill/relaunch the running dogfood (file sync only; verified previously).
- No new schema/migration; no dependency changes.
- Sonnet implementers + per-task review + broad Opus review, per standing instruction.

## Relationship to prior work / open follow-ups

- This completes the SessionStart-local-cold-boot fix (`308aeef0`): that fix made `start`
  *able* to boot local; this makes the hook invocation *persist* it.
- Still-open, unchanged: the `npx install` local-boot path references the retired
  `worker-service.cjs` (separate follow-up); the `resolveLocalScope`-against-test-PG unit
  coverage gap (tracked from the cold-boot branch).
