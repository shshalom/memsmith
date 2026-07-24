# SessionStart Local Cold-Boot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `server-service.cjs`'s `start` command runtime-aware so a fresh marketplace install self-boots the local embedded runtime on SessionStart, instead of failing with "MEMSMITH_SERVER_DATABASE_URL is required".

**Architecture:** In `runServerServiceCli`'s `start` case (`ServerService.ts`), after the existing "reuse running server" early-return, resolve `selectRuntime(cwd)`. If `local`, boot via `startLocalRuntime()` (embedded PG + import + server loop + marker mint). If `server`, keep the current server-foreground path. This pulls the local-boot code into the shipped bundle; a build assertion guards that it stays there.

**Tech Stack:** TypeScript, esbuild bundling (`scripts/build-hooks.js`), `bun test`, node/bun runtime.

## Global Constraints

- Branch from `main` (`f457d86b`); already on branch `sessionstart-local-coldboot`. Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Dogfood must never be at risk.** Any integration test uses a throwaway `MEMSMITH_DATA_DIR` + a non-`:55433` PG port, and hard-refuses to run against `~/.memsmith` or `:55433`.
- No new schema/migration; no dependency changes.
- The `start` reuse early-return (running-server pid check) MUST remain first and unchanged — never double-boot a running instance (e.g. the dogfood).
- `cwd` for runtime resolution = `process.env.MEMSMITH_PROJECT_CWD ?? process.cwd()` (matches the rest of the runtime).
- Rebuild + sync (`npm run build-and-sync`) is part of the deliverable but is the FINAL task; the build must not be relied on to kill/relaunch the dogfood (operator handles that).

## Existing primitives (reuse, do NOT reimplement)

- `selectRuntime(cwd): 'local' | 'server'` — `src/services/hooks/runtime-selector.ts:53` (per-project marker-aware).
- `startLocalRuntime(options?): Promise<{connectionString}>` — `src/server/runtime/local-runtime.ts:17`. Boots embedded PG, runs first-run import (mints `.memsmith` marker + key via `resolveLocalScope`), then blocks in the server foreground loop. Accepts injectable `manager`/`startService`/`runImport` seams for tests.
- `runServerForeground(port, host)` / `runServerForegroundForLocal()` — `ServerService.ts` (server-mode foreground; unchanged).
- Build assertion pattern — `scripts/build-hooks.js:377-392` (read built `.cjs`, regex-match, `throw` on violation).

---

## Pre-Flight Note

`runServerServiceCli`'s `start` case currently (ServerService.ts ~line 381) does:
reuse-check → `startCommandWantsDaemon` → (daemon) `spawnServerDaemon` OR
(foreground) `runServerForeground`. The runtime branch must be inserted so BOTH
the daemon and foreground sub-paths pick local when `selectRuntime()==='local'`.
For the daemon sub-path, the detached child re-enters `runServerServiceCli` (via
`--daemon` / spawn) and must ALSO resolve local there — the simplest correct
design is to branch to `startLocalRuntime()` for the foreground/`--daemon`
execution points, leaving `spawnServerDaemon`'s detach mechanism intact. Task 1
handles the foreground + `--daemon` execution points; the daemon-spawn wrapper
just re-invokes the same runtime-aware execution in the child.

---

## File Structure

- `src/server/runtime/ServerService.ts` — `start` / `--daemon` execution becomes runtime-aware (Task 1).
- `tests/server/server-service-start-runtime.test.ts` — new unit test for the dispatch branch (Task 1).
- `scripts/build-hooks.js` — build assertion that the shipped `server-service.cjs` contains the local-boot symbols (Task 2).
- `tests/server/local-coldboot-integration.test.ts` — new self-skipping integration test (Task 3).
- Rebuild + sync the bundle (Task 4).

---

## Task 1: Runtime-aware `start` dispatch

**Files:**
- Modify: `src/server/runtime/ServerService.ts` (the `start` case in `runServerServiceCli`, and the `--daemon` case / foreground execution point)
- Test: `tests/server/server-service-start-runtime.test.ts`

**Interfaces:**
- Consumes: `selectRuntime` (import from `../../services/hooks/runtime-selector.js`), `startLocalRuntime` (import from `./local-runtime.js`).
- Produces: a runtime-aware foreground entry the `start` and `--daemon` cases call. Proposed extraction: a local async function `runRuntimeForeground(port, host)` that does:
  ```ts
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  if (selectRuntime(cwd) === 'local') {
    const { startLocalRuntime } = await import('./local-runtime.js');
    await startLocalRuntime();
    return;
  }
  await runServerForeground(port, host);
  ```
  Both the `start` foreground path and the `--daemon` case call `runRuntimeForeground` instead of `runServerForeground` directly. The reuse early-return and `spawnServerDaemon` detach mechanism are unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/server/server-service-start-runtime.test.ts`. Test the extracted `runRuntimeForeground` (export it from ServerService.ts for testability) with injected seams. Since `startLocalRuntime`/`runServerForeground` do real IO, the test stubs them via module mocking (`mock.module`) or — preferred — `runRuntimeForeground` takes optional injected deps:

```ts
import { describe, it, expect } from 'bun:test';
import { runRuntimeForeground } from '../../src/server/runtime/ServerService.js';

describe('runRuntimeForeground runtime branch', () => {
  it('boots local when selectRuntime returns local', async () => {
    const calls: string[] = [];
    await runRuntimeForeground(0, '127.0.0.1', {
      selectRuntime: () => 'local',
      startLocal: async () => { calls.push('local'); },
      startServer: async () => { calls.push('server'); },
    });
    expect(calls).toEqual(['local']);
  });

  it('boots server when selectRuntime returns server', async () => {
    const calls: string[] = [];
    await runRuntimeForeground(0, '127.0.0.1', {
      selectRuntime: () => 'server',
      startLocal: async () => { calls.push('local'); },
      startServer: async () => { calls.push('server'); },
    });
    expect(calls).toEqual(['server']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/server/server-service-start-runtime.test.ts`
Expected: FAIL — `runRuntimeForeground` is not exported / does not exist.

- [ ] **Step 3: Implement `runRuntimeForeground`**

In `src/server/runtime/ServerService.ts`, add the import at the top:
```ts
import { selectRuntime } from '../../services/hooks/runtime-selector.js';
```
Add the exported function near `runServerForeground` (after `runServerForegroundForLocal`, ~line 493):
```ts
// Runtime-aware foreground entry used by `start` (foreground) and the internal
// `--daemon` child. When the resolved runtime is local, boot the embedded PG +
// server loop (startLocalRuntime); otherwise run the server foreground. The
// deps object is a test seam; production omits it.
export interface RuntimeForegroundDeps {
  selectRuntime?: (cwd: string) => 'local' | 'server';
  startLocal?: () => Promise<void>;
  startServer?: (port: number, host: string) => Promise<void>;
}
export async function runRuntimeForeground(
  port: number,
  host: string,
  deps: RuntimeForegroundDeps = {},
): Promise<void> {
  const pick = deps.selectRuntime ?? selectRuntime;
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  if (pick(cwd) === 'local') {
    const startLocal = deps.startLocal ?? (async () => {
      const { startLocalRuntime } = await import('./local-runtime.js');
      await startLocalRuntime();
    });
    await startLocal();
    return;
  }
  const startServer = deps.startServer ?? runServerForeground;
  await startServer(port, host);
}
```

- [ ] **Step 4: Wire `start` and `--daemon` to use it**

There are THREE `await runServerForeground(port, host);` call sites (verified: lines 406, 450, 492). Change ONLY two:
- Line 406 (the `start` case): replace with `await runRuntimeForeground(port, host);`
- Line 450 (the `--daemon` case): replace with `await runRuntimeForeground(port, host);`
- **Line 492 (`runServerForegroundForLocal`) — DO NOT CHANGE.** It is the internal helper `startLocalRuntime`'s `defaultStartService` calls to run the server loop AFTER embedded PG is up; making it runtime-aware would infinitely recurse (local → startLocalRuntime → runServerForegroundForLocal → local → …). Leave it calling `runServerForeground` directly.

(The reuse early-return at the top of `start`, and `spawnServerDaemon`, are unchanged.)

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test tests/server/server-service-start-runtime.test.ts`
Expected: PASS (both branches).

- [ ] **Step 6: Typecheck + adjacent suites**

Run: `npx tsc --noEmit && bun test tests/server/local-runtime.test.ts tests/server/server-service.test.ts`
Expected: tsc exit 0 (ignore editor-only false positives: `bun:test`, `.js` import resolution, `ZodTypeAny`); tests PASS (or same pre-existing ECONNREFUSED skips as baseline — no NEW failures).

- [ ] **Step 7: Commit**

```bash
git add src/server/runtime/ServerService.ts tests/server/server-service-start-runtime.test.ts
git commit -m "feat(runtime): runtime-aware start — boot local embedded runtime on SessionStart

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Build assertion — shipped bundle contains local-boot code

**Files:**
- Modify: `scripts/build-hooks.js` (after the `✓ server-service built` log, ~line 324)

**Interfaces:**
- Consumes: the built `server-service.cjs`.
- Produces: a build-time `throw` if the bundle lacks the local-boot symbols (prevents silent regression to the current broken state).

- [ ] **Step 1: Add the assertion**

In `scripts/build-hooks.js`, immediately after the `console.log(\`✓ server-service built ...\`)` line (~line 324), add (mirroring the existing mcp-server bundle-content assertion pattern at lines 377-392):

```js
    const serverBundleContent = fs.readFileSync(`${hooksDir}/${SERVER_SERVICE.name}.cjs`, 'utf-8');
    // The SessionStart hook runs `server-service.cjs start`; a fresh LOCAL install
    // must self-boot the embedded runtime. That path pulls startLocalRuntime +
    // EmbeddedPostgresManager into this bundle. If they are absent, `start` in
    // local mode fails with "MEMSMITH_SERVER_DATABASE_URL is required" and the
    // runtime never boots (see 2026-07-24-sessionstart-local-coldboot spec).
    for (const symbol of ['startLocalRuntime', 'EmbeddedPostgresManager']) {
      if (!serverBundleContent.includes(symbol)) {
        throw new Error(
          `server-service.cjs is missing "${symbol}" — the local cold-boot path is not in the bundle. ` +
          `SessionStart \`start\` would fail to boot a fresh local install. ` +
          `Ensure runServerServiceCli's start path imports startLocalRuntime (runtime-aware start).`
        );
      }
    }
```

- [ ] **Step 2: Run the build to verify the assertion passes (post-Task-1)**

Run: `node scripts/build-hooks.js` (or the project's build entry — check `package.json` `build` script; use the same one `build-and-sync` calls, WITHOUT the sync/restart).
Expected: build succeeds, prints `✓ server-service built`, no assertion throw (because Task 1 pulled the symbols in).

- [ ] **Step 3: Prove the assertion actually guards (negative check)**

Temporarily confirm the assertion has teeth: `grep -c "startLocalRuntime" plugin/scripts/server-service.cjs` should be > 0 after the build. (Do NOT commit a broken bundle; this is just a verification that the symbols are present. If they are 0, Task 1 is incomplete — return to Task 1.)

Run: `grep -c "startLocalRuntime\|EmbeddedPostgresManager" plugin/scripts/server-service.cjs`
Expected: > 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-hooks.js
git commit -m "build: assert server-service bundle contains local cold-boot symbols

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Self-skipping local cold-boot integration test

**Files:**
- Test: `tests/server/local-coldboot-integration.test.ts` (new)

**Interfaces:**
- Consumes: `runRuntimeForeground` / `startLocalRuntime`, `EmbeddedPostgresManager`.
- Produces: nothing (test-only).

**Dogfood guard (mandatory):** the test MUST refuse to run against the dogfood. Resolve a throwaway `MEMSMITH_DATA_DIR` (e.g. `os.tmpdir()/ms-coldboot-<uuid>`) and a non-`:55433` `MEMSMITH_LOCAL_PG_PORT`; assert both are NOT the dogfood values before doing anything. Self-skip when the embedded PG binaries are unavailable OR a required env opt-in (`MEMSMITH_TEST_COLDBOOT=1`) is unset — cold-boot spins a real Postgres, so it is opt-in like the other heavy PG tests, NOT run by default.

- [ ] **Step 1: Write the self-skipping test**

Create `tests/server/local-coldboot-integration.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync, existsSync } from 'fs';

const OPT_IN = process.env.MEMSMITH_TEST_COLDBOOT === '1';
const DATA_DIR = join(tmpdir(), `ms-coldboot-${randomUUID()}`);
const PG_PORT = '55450'; // non-dogfood

describe('local cold-boot (opt-in integration)', () => {
  afterAll(() => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} });

  if (OPT_IN) {
    it('boots embedded PG + mints marker under a throwaway data dir', async () => {
      // HARD dogfood guard
      expect(DATA_DIR.includes('/.memsmith')).toBe(false);
      expect(PG_PORT).not.toBe('55433');

      process.env.MEMSMITH_DATA_DIR = DATA_DIR;
      process.env.MEMSMITH_LOCAL_PG_PORT = PG_PORT;
      process.env.MEMSMITH_PROJECT_CWD = DATA_DIR; // marker minted here

      const { EmbeddedPostgresManager } = await import('../../src/server/runtime/EmbeddedPostgresManager.js');
      const { startLocalRuntime } = await import('../../src/server/runtime/local-runtime.js');

      // Boot embedded PG + import, but inject a no-op startService so the test
      // does NOT block in the server foreground loop.
      const result = await startLocalRuntime({ startService: async () => {} });
      expect(result.connectionString).toContain(PG_PORT);

      // marker minted at the project cwd
      expect(existsSync(join(DATA_DIR, '.memsmith', 'project.json'))).toBe(true);

      // clean shutdown of the throwaway PG
      await new EmbeddedPostgresManager().stop();
    });
  }
});
```

(Adjust import paths / the `startService` seam name to match `StartLocalRuntimeOptions` in local-runtime.ts — it already exposes `startService` and `manager` seams.)

- [ ] **Step 2: Run WITHOUT opt-in → clean skip**

Run: `bun test tests/server/local-coldboot-integration.test.ts`
Expected: "Ran 0 tests" (or the describe registers but the `if (OPT_IN)` block registers no `it`) — no PG spun, no crash.

- [ ] **Step 3: (Optional, if a throwaway PG is feasible here) run WITH opt-in**

Run: `MEMSMITH_TEST_COLDBOOT=1 bun test tests/server/local-coldboot-integration.test.ts`
Expected: PASS — throwaway PG boots on `:55450`, marker minted under the temp dir, PG stopped. If the embedded PG binaries are not available in this environment or `:55450` is busy, note in the report that it was skipped/couldn't run and rely on Task 1's unit test + Task 4 manual acceptance. NEVER point it at `~/.memsmith`/`:55433`.

- [ ] **Step 4: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: exit 0.

```bash
git add tests/server/local-coldboot-integration.test.ts
git commit -m "test(runtime): opt-in local cold-boot integration (throwaway PG, dogfood-guarded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Rebuild + sync the marketplace bundle

**Files:** none (build artifact + marketplace sync).

**Interfaces:** consumes all prior tasks; produces the shipped `server-service.cjs` with local-boot code.

- [ ] **Step 1: Build + sync**

Run: `npm run build-and-sync`
Expected: builds all bundles (Task 2's assertion passes), syncs to `~/.claude/plugins/marketplaces/shshalom/plugin`.

**IMPORTANT:** if `build-and-sync` restarts/kills the running dogfood, that is an operator concern — do NOT let the build target or kill `~/.memsmith`. The build itself only writes bundle files + syncs; the restart step (if any) must be verified to not disrupt the dogfood, or run the build WITHOUT the restart step. Confirm the dogfood (`:38879`/`:55433`) is still healthy after.

- [ ] **Step 2: Verify the shipped bundle**

Run: `grep -c "startLocalRuntime\|EmbeddedPostgresManager" ~/.claude/plugins/marketplaces/shshalom/plugin/scripts/server-service.cjs`
Expected: > 0 (the fix reached the shipped artifact).

- [ ] **Step 3: Commit the rebuilt bundle**

```bash
git add plugin/scripts/server-service.cjs
git commit -m "chore(build): rebuild bundle with runtime-aware start (local cold-boot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If `build-and-sync` also touches other generated files under `plugin/`, stage only the intentional bundle changes; review `git status` and include the server-service bundle + any co-generated hook manifests that legitimately changed. Do NOT commit unrelated churn.)

---

## Self-Review

- **Spec coverage:** runtime-aware `start` (spec Approach) → Task 1. Build assertion (spec Testing #3) → Task 2. Self-skipping integration + dogfood guard (spec Testing #4) → Task 3. Rebuild+sync deliverable (spec Global Constraints) → Task 4. Unit dispatch tests (spec Testing #1-2) → Task 1 Step 1.
- **Placeholder scan:** `runRuntimeForeground` body, the assertion code, and the test are complete; the one "adjust to match `StartLocalRuntimeOptions`" note points at the real existing seam (`startService`) and is a verify-not-invent instruction.
- **Type consistency:** `runRuntimeForeground(port, host, deps?)` and `RuntimeForegroundDeps` names are identical across Task 1 code and its test; `startLocalRuntime`'s `startService` seam matches `local-runtime.ts:9`.
- **Dogfood safety:** Task 3 hard-guards data dir + port; Task 4 flags the build-restart hazard. Reuse early-return preserved in Task 1 (never double-boots a running dogfood).
