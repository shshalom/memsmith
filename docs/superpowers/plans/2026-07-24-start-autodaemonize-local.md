# `start` Auto-Daemonizes for Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `start` auto-detach when the resolved runtime is local, so the SessionStart hook returns immediately and the local runtime persists (embedded PG + server stay up after the hook completes). Server-mode foreground behavior is unchanged.

**Architecture:** Extract the "which path does `start` take" decision into a tiny pure function `resolveStartAction({ wantsDaemon, isLocal, hasRunningServer }) → 'reuse' | 'daemon' | 'foreground'` (unit-testable without spawning). The `start` case computes the three inputs (`readServerPidFile` ownership, `startCommandWantsDaemon`, `selectRuntime(cwd)==='local'`) and dispatches on the result. Also set `MEMSMITH_PROJECT_CWD` explicitly on the `spawnServerDaemon` child env.

**Tech Stack:** TypeScript, `bun test`.

## Global Constraints

- Branch from `main` (`308aeef0`); already on branch `start-autodaemonize-local`. Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Dogfood must never be at risk.** Unit tests exercise the pure decision function only — no real spawn, no real PG, no `~/.memsmith`/`:55433`.
- Server-mode (`selectRuntime==='server'`) behavior MUST be unchanged: bare `start` stays foreground; only local gains auto-detach.
- The reuse early-return (running-server pid check) MUST remain the first decision — never double-boot a running instance.
- No hook / `build-hooks.js` / manifest change (D3).
- No new schema/migration; no dependency changes.
- Rebuild + sync (`npm run build-and-sync`) is the final task; file-sync only, must not disrupt the running dogfood.

## Existing anchors (verified)

- `runServerServiceCli` `start` case at `ServerService.ts:382-408`: reuse-check (383-387) → `wantsDaemon = startCommandWantsDaemon(argv.slice(1))` (393) → if daemon: `spawnServerDaemon` + `{status:'starting'}` return (394-402) → else `await runRuntimeForeground(port, host)` (407).
- `selectRuntime` already imported (`ServerService.ts:11`).
- `spawnServerDaemon(port)` at `ServerService.ts:910`; child env currently `{ ...sanitizeEnv(process.env), MEMSMITH_SERVER_PORT: String(port) }`.
- `startCommandWantsDaemon(startArgs)` exported at `:317`.
- `sanitizeEnv` passes `MEMSMITH_PROJECT_CWD` through (only strips `CLAUDE_CODE_*`/`CLAUDECODE_*` + proxy/session denylist) — so D2 is belt-and-suspenders, not a strip-fix.

---

## Task 1: Auto-daemonize local `start` + explicit PROJECT_CWD on daemon child

**Files:**
- Modify: `src/server/runtime/ServerService.ts` (add `resolveStartAction`; rewire `start` case; `spawnServerDaemon` env)
- Test: `tests/server/server-service-start-action.test.ts` (new)

**Interfaces:**
- Consumes: `selectRuntime`, `startCommandWantsDaemon`, `readServerPidFile`/`verifyPidFileOwnership`, `spawnServerDaemon` (all existing).
- Produces: exported pure function
  `resolveStartAction(input: { wantsDaemon: boolean; isLocal: boolean; hasRunningServer: boolean }): 'reuse' | 'daemon' | 'foreground'`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/server-service-start-action.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { resolveStartAction } from '../../src/server/runtime/ServerService.js';

describe('resolveStartAction', () => {
  it('reuse wins first — running server short-circuits regardless of runtime/daemon', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: true,  hasRunningServer: true })).toBe('reuse');
    expect(resolveStartAction({ wantsDaemon: true,  isLocal: false, hasRunningServer: true })).toBe('reuse');
    expect(resolveStartAction({ wantsDaemon: false, isLocal: false, hasRunningServer: true })).toBe('reuse');
  });

  it('local auto-detaches (no --daemon needed) when nothing is running', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: true, hasRunningServer: false })).toBe('daemon');
  });

  it('explicit --daemon detaches for both runtimes', () => {
    expect(resolveStartAction({ wantsDaemon: true, isLocal: true,  hasRunningServer: false })).toBe('daemon');
    expect(resolveStartAction({ wantsDaemon: true, isLocal: false, hasRunningServer: false })).toBe('daemon');
  });

  it('server-mode bare start stays foreground (unchanged)', () => {
    expect(resolveStartAction({ wantsDaemon: false, isLocal: false, hasRunningServer: false })).toBe('foreground');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/server-service-start-action.test.ts`
Expected: FAIL — `resolveStartAction` not exported / does not exist.

- [ ] **Step 3: Implement `resolveStartAction`**

In `src/server/runtime/ServerService.ts`, add near `startCommandWantsDaemon` (~line 317):

```ts
// Decides which path bare/`--daemon` `start` takes. Pure + exported for unit
// tests. Priority: a running server is always reused first; then local auto-
// detaches (a SessionStart hook cannot host the blocking foreground server
// loop, so local MUST daemonize) or an explicit --daemon detaches; otherwise
// server-mode runs foreground (systemd Type=simple owns the process). See
// 2026-07-24-start-autodaemonize-local spec.
export function resolveStartAction(input: {
  wantsDaemon: boolean;
  isLocal: boolean;
  hasRunningServer: boolean;
}): 'reuse' | 'daemon' | 'foreground' {
  if (input.hasRunningServer) return 'reuse';
  if (input.wantsDaemon || input.isLocal) return 'daemon';
  return 'foreground';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/server/server-service-start-action.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Rewire the `start` case to use it**

Replace the `start` case body (`ServerService.ts:382-408`) so the reuse-check, daemon, and foreground paths dispatch through `resolveStartAction`:

```ts
    case 'start': {
      const existing = readServerPidFile();
      const hasRunningServer = verifyPidFileOwnership(existing);
      const wantsDaemon = startCommandWantsDaemon(argv.slice(1));
      const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
      const isLocal = selectRuntime(cwd) === 'local';

      const action = resolveStartAction({ wantsDaemon, isLocal, hasRunningServer });

      if (action === 'reuse') {
        console.log(JSON.stringify({ status: 'ready', runtime: SERVER_RUNTIME, pid: existing!.pid, port: existing!.port }));
        return;
      }

      if (action === 'daemon') {
        // Detached so the caller (e.g. the short-lived SessionStart hook) does
        // NOT block in the server loop. The child re-enters via `--daemon` →
        // runRuntimeForeground, which boots local or server per selectRuntime.
        const daemonPid = spawnServerDaemon(port);
        if (daemonPid === undefined) {
          console.error('Failed to spawn server daemon.');
          process.exit(1);
        }
        console.log(JSON.stringify({ status: 'starting', runtime: SERVER_RUNTIME, pid: daemonPid, port }));
        return;
      }

      // action === 'foreground' — server-mode default (systemd Type=simple).
      await runRuntimeForeground(port, host);
      return;
    }
```

(Preserve the existing `#2444` comment rationale near the daemon/foreground code; keep `existing!` only where `hasRunningServer` guarantees non-null — i.e. inside the `reuse` branch.)

- [ ] **Step 6: Add explicit `MEMSMITH_PROJECT_CWD` to the daemon child env**

In `spawnServerDaemon` (`ServerService.ts:910`), change the child `env` block to:

```ts
    env: {
      ...sanitizeEnv(process.env),
      MEMSMITH_SERVER_PORT: String(port),
      MEMSMITH_PROJECT_CWD: process.env.MEMSMITH_PROJECT_CWD ?? process.cwd(),
    },
```

- [ ] **Step 7: Typecheck + touched suites**

Run: `npx tsc --noEmit && bun test tests/server/server-service-start-action.test.ts tests/server/server-service-start-runtime.test.ts tests/server/server-service.test.ts`
Expected: tsc exit 0 (ignore editor-only false positives: `bun:test`, `.js` import resolution, `ZodTypeAny`); tests PASS (or same pre-existing ECONNREFUSED skips as baseline — no NEW failures).

- [ ] **Step 8: Commit**

```bash
git add src/server/runtime/ServerService.ts tests/server/server-service-start-action.test.ts
git commit -m "feat(runtime): local start auto-daemonizes so the runtime persists past the hook

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Rebuild + sync the marketplace bundle

**Files:** none (build artifact + marketplace sync).

**Interfaces:** consumes Task 1; produces the shipped `server-service.cjs` with the auto-detach behavior.

- [ ] **Step 1: Build + sync**

Confirm the dogfood is healthy first (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:38879/api/health` → expect 200 if running, or note it's intentionally stopped for P3).

Run: `npm run build-and-sync`
Expected: builds all bundles (the prior cold-boot build assertion still passes — `startLocalRuntime` + proxy string remain), syncs to `~/.claude/plugins/marketplaces/shshalom/plugin`. File-sync only; must NOT kill/relaunch the dogfood. Confirm dogfood health unchanged after.

- [ ] **Step 2: Verify the shipped bundle carries the fix**

Run: `grep -c "resolveStartAction" ~/.claude/plugins/marketplaces/shshalom/plugin/scripts/server-service.cjs`
Expected: > 0 (the auto-detach decision reached the shipped artifact). Note: `resolveStartAction` is a function name and may be minified; if the count is 0, instead grep for a stable co-located string or confirm via `git diff --stat` that `plugin/scripts/server-service.cjs` changed. The authoritative check is that the bundle rebuilt from Task 1's source.

- [ ] **Step 3: Commit the rebuilt bundle**

Review `git status --short` — expect only `plugin/scripts/*.cjs` (rebuilt bundles). Stage those explicitly; do not commit unrelated churn.

```bash
git add plugin/scripts/mcp-server.cjs plugin/scripts/server-service.cjs plugin/scripts/transcript-watcher.cjs
git commit -m "chore(build): rebuild bundle with local start auto-daemonize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If only `server-service.cjs` changed, stage only that. Match the actual `git status`.)

---

## Self-Review

- **Spec coverage:** D1 (local auto-detach) → Task 1 Steps 3+5 via `resolveStartAction`. D2 (explicit PROJECT_CWD on child) → Task 1 Step 6. D3 (no hook change) → honored (no build-hooks.js edit). Rebuild+sync deliverable → Task 2. Testing #1-4 (local-detach / server-foreground / --daemon / reuse) → Task 1 Step 1's four cases. Testing #5 (child env) → covered by Step 6 (the child-env assertion could be added, but the pure decision function is the higher-value unit; the env change is a 1-line literal — acceptable to verify by inspection/tsc).
- **Placeholder scan:** `resolveStartAction` body, the rewired `start` case, and the env block are complete literals; the Step 2 grep-minification caveat is a real instruction, not a placeholder.
- **Type consistency:** `resolveStartAction(input: {wantsDaemon, isLocal, hasRunningServer}) → 'reuse'|'daemon'|'foreground'` identical across the function, its test, and the `start`-case call. `existing!` non-null only in the `reuse` branch (guarded by `hasRunningServer`).
- **Server-mode safety:** `resolveStartAction` returns `foreground` for `{wantsDaemon:false, isLocal:false}` — the explicit unchanged-server-mode case, unit-tested.
