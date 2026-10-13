# Distribution and lifecycle CLI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx memsmith install` work from npm, and make `memsmith start|stop|restart|status|doctor [--fix]` reliably manage the local MemSmith server.

**Architecture:** A new CLI module, `src/npx-cli/commands/lifecycle.ts`, owns every lifecycle command. It talks to the installed `server-service.cjs` through an injected spawner and to the server through `GET /api/health`. Server-side changes are limited to `stop` escalation, a `status` exit code, a shared server-state module, and a cross-process Postgres stop. Releases publish from a tag through npm trusted publishing after a clean-room smoke test.

**Tech Stack:** TypeScript, Bun (`bun test`), Node 20 CLI bundle (`dist/npx-cli/index.js`), GitHub Actions, npm 11.

**Spec:** `docs/superpowers/specs/2026-10-13-distribution-and-lifecycle-cli-design.md`

## Global constraints

- Package name: `memsmith`, unscoped.
- Publishing uses npm trusted publishing (OIDC) with `--provenance`. No `NPM_TOKEN`.
- Workflow Node version stays `20`; npm is upgraded with `npm install -g npm@^11.5.1`.
- `memsmith start` default timeout: 300 seconds. Health poll interval: 500 ms.
- `start` succeeds on `initialized: true`, including a `503` with `status: "degraded"` (warn).
- `server-service.cjs stop`: `SIGTERM`, wait 5 s, `SIGKILL`, wait 2 s. Exit 1 and keep state files if the process survives.
- `stopExternal()`: `SIGTERM`, poll 15 s, `SIGINT`, poll 15 s.
- A `MEMSMITH_SERVER_URL` host other than `127.0.0.1`, `localhost`, or `::1` is remote; lifecycle commands exit 1 for it.
- Out of scope: `adopt`, `cleanup`, the `transcript watch` fallback, and `spawnBunWorkerCommand`. Do not touch them.
- Comments only where code cannot say it (user `CLAUDE.md`). No narration comments.
- Every new test must fail against the bug it pins.
- Lifecycle commands accept the user's `MEMSMITH_SERVER_URL` port and pass it to the daemon as `MEMSMITH_SERVER_PORT`.

## Review focus

1. **Server already running when `start` runs:** prints status, exits 0, spawns nothing. Pinned in Task 3.
2. **Daemon exits during `start` before becoming healthy** (for example, a Postgres port conflict): `start` must fail fast with the log path, not wait the full 300 s. Pinned in Task 3.
3. **`stop` when nothing runs:** exits 0 with "Server is not running"; `stop --all` still stops a leftover Postgres. Pinned in Task 3.
4. **`postmaster.pid` belongs to a different data directory or port:** `stopExternal()` sends no signal. Pinned in Task 2.
5. **`doctor --fix` when the server is remote:** applies no server repair and says why. Pinned in Task 6.

## File structure

| File | Responsibility |
| --- | --- |
| `src/server/runtime/server-state.ts` (new) | Read and remove the server PID, port, and runtime files. No server imports. |
| `src/server/runtime/stop-process.ts` (new) | Signal a PID with escalation and report whether it exited. |
| `src/server/runtime/ServerService.ts` | Use the two modules above. `stop` escalates; `status` exits 1 when not running. |
| `src/server/runtime/EmbeddedPostgresManager.ts` | Add `stopExternal()`. |
| `src/npx-cli/commands/lifecycle.ts` (new) | `start`, `stop`, `restart`, `status`, server address resolution, health wait. |
| `src/npx-cli/commands/runtime.ts` | Remove worker lifecycle functions; keep the out-of-scope ones. Route `api-key` to the server script. |
| `src/npx-cli/commands/server.ts` | `server` and `worker` lifecycle aliases call `lifecycle.ts`. |
| `src/npx-cli/index.ts` | Top-level lifecycle commands call `lifecycle.ts` with their arguments. Help text. |
| `src/npx-cli/commands/install.ts` | Auto-start runs `start --daemon`. Export `installMarketplaceDependencies()`. |
| `src/npx-cli/commands/doctor.ts` | Server check, version check, `--fix`. |
| `scripts/smoke-clean-room.mjs` (new) | Release gate. |
| `.github/workflows/npm-publish.yml` | Trusted publishing, version check, dry run, nightly. |
| `README.md`, `CLAUDE.md` | Install and management docs. |

---

### Task 1: Shared server-state module and `stop` escalation

**Files:**
- Create: `src/server/runtime/server-state.ts`
- Create: `src/server/runtime/stop-process.ts`
- Modify: `src/server/runtime/ServerService.ts` (remove `readServerPidFile`, `readServerRuntimeState`, `removeServerState`, `waitForPidExit` at `:1385-1458`; rewrite the `stop` and `status` cases at `:736-770`)
- Test: `tests/server/runtime/stop-process.test.ts`, `tests/server/runtime/server-state.test.ts`

**Interfaces:**
- Produces:
  - `serverStateFiles(): ServerStateFiles` where `ServerStateFiles = { pid: string; port: string; runtime: string }`
  - `readServerPidFile(files?: ServerStateFiles): PidInfo | null`
  - `readServerRuntimeState<T = Record<string, unknown>>(files?: ServerStateFiles): T | null`
  - `removeServerState(files?: ServerStateFiles): void`
  - `stopProcess(pid: number, deps?: StopProcessDeps): Promise<'exited' | 'survived'>`
  - `interface StopProcessDeps { kill?: (pid: number, signal: NodeJS.Signals) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; termWaitMs?: number; killWaitMs?: number }`

- [ ] **Step 1: Write the failing tests**

`tests/server/runtime/stop-process.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { stopProcess } from '../../../src/server/runtime/stop-process.js';

function fakeProcess(opts: { diesOn: NodeJS.Signals | null }) {
  let alive = true;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    deps: {
      kill: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === opts.diesOn || (opts.diesOn === 'SIGTERM' && signal === 'SIGKILL')) alive = false;
      },
      isAlive: () => alive,
      sleep: async () => {},
      termWaitMs: 50,
      killWaitMs: 50,
    },
  };
}

// The old stop waited 5s after SIGTERM, then printed "Server stopped" even when
// the process was still alive.
describe('stopProcess', () => {
  it('returns exited without escalating when SIGTERM is enough', async () => {
    const p = fakeProcess({ diesOn: 'SIGTERM' });
    expect(await stopProcess(123, p.deps)).toBe('exited');
    expect(p.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const p = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(123, p.deps)).toBe('exited');
    expect(p.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports survived when even SIGKILL does not end the process', async () => {
    const p = fakeProcess({ diesOn: null });
    expect(await stopProcess(123, p.deps)).toBe('survived');
  });
});
```

`tests/server/runtime/server-state.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readServerPidFile, removeServerState } from '../../../src/server/runtime/server-state.js';

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-state-'));
  return { pid: join(dir, 'pid'), port: join(dir, 'port'), runtime: join(dir, 'runtime.json') };
}

describe('server-state', () => {
  it('removes all three state files', () => {
    const f = files();
    for (const p of Object.values(f)) writeFileSync(p, '{}');
    removeServerState(f);
    expect(Object.values(f).some(existsSync)).toBe(false);
  });

  it('returns null for a corrupt pid file instead of throwing', () => {
    const f = files();
    writeFileSync(f.pid, 'not json');
    expect(readServerPidFile(f)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/server/runtime/stop-process.test.ts tests/server/runtime/server-state.test.ts`
Expected: FAIL with "Cannot find module" for both files.

- [ ] **Step 3: Implement the modules**

`src/server/runtime/server-state.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, rmSync } from 'fs';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { PidInfo } from '../../supervisor/process-registry.js';

export interface ServerStateFiles { pid: string; port: string; runtime: string }

export function serverStateFiles(): ServerStateFiles {
  return { pid: paths.serverPid(), port: paths.serverPort(), runtime: paths.serverRuntime() };
}

function readJson<T>(path: string, label: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', `Failed to read ${label}`, { path }, err);
    return null;
  }
}

export function readServerPidFile(files: ServerStateFiles = serverStateFiles()): PidInfo | null {
  return readJson<PidInfo>(files.pid, 'server PID file');
}

export function readServerRuntimeState<T = Record<string, unknown>>(
  files: ServerStateFiles = serverStateFiles(),
): T | null {
  return readJson<T>(files.runtime, 'server runtime state file');
}

export function removeServerState(files: ServerStateFiles = serverStateFiles()): void {
  rmSync(files.pid, { force: true });
  rmSync(files.port, { force: true });
  rmSync(files.runtime, { force: true });
}
```

`src/server/runtime/stop-process.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { isPidAlive } from '../../supervisor/process-registry.js';

export interface StopProcessDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  termWaitMs?: number;
  killWaitMs?: number;
}

const POLL_MS = 100;

export async function stopProcess(pid: number, deps: StopProcessDeps = {}): Promise<'exited' | 'survived'> {
  const kill = deps.kill ?? ((p, s) => process.kill(p, s));
  const isAlive = deps.isAlive ?? isPidAlive;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const waitForExit = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
      if (!isAlive(pid)) return true;
      await sleep(POLL_MS);
    }
    return !isAlive(pid);
  };

  try { kill(pid, 'SIGTERM'); } catch { return isAlive(pid) ? 'survived' : 'exited'; }
  if (await waitForExit(deps.termWaitMs ?? 5000)) return 'exited';
  try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  return (await waitForExit(deps.killWaitMs ?? 2000)) ? 'exited' : 'survived';
}
```

Confirm `isPidAlive` is exported from `src/supervisor/process-registry.ts` (it is used by `EmbeddedPostgresManager.ts:6`).

- [ ] **Step 4: Wire `ServerService.ts`**

Delete `readServerPidFile`, `readServerRuntimeState`, `removeServerState`, and `waitForPidExit` from `ServerService.ts`, and import from the new modules:

```ts
import { readServerPidFile, readServerRuntimeState, removeServerState } from './server-state.js';
import { stopProcess } from './stop-process.js';
```

Replace the `stop` case:

```ts
    case 'stop': {
      const existing = readServerPidFile();
      if (!verifyPidFileOwnership(existing)) {
        removeServerState();
        console.log('Server is not running');
        return;
      }
      if ((await stopProcess(existing.pid)) === 'survived') {
        console.error(`Server process ${existing.pid} did not exit after SIGKILL; state files kept.`);
        process.exit(1);
      }
      removeServerState();
      console.log('Server stopped');
      return;
    }
```

Replace the `status` case so it agrees with `start` and exits 1 when not running:

```ts
    case 'status': {
      const running = await findRunningServer(port, host);
      if (!running) {
        console.log('Server is not running');
        process.exit(1);
      }
      const state = readServerRuntimeState<ServerRuntimeState>();
      console.log('Server is running');
      console.log(`  PID: ${running.pid ?? 'unknown (no PID file)'}`);
      console.log(`  Port: ${running.port}`);
      if (state) {
        console.log(`  Runtime: ${state.runtime}`);
        console.log(`  Started: ${state.startedAt}`);
      }
      return;
    }
```

`writeServerState` stays in `ServerService.ts`; change its three `paths.*()` calls to use `serverStateFiles()` so both modules agree on paths.

- [ ] **Step 5: Run the tests and typecheck**

Run: `bun test tests/server/runtime/ && npx tsc --noEmit`
Expected: PASS, no type errors. `tests/server/runtime/find-running-server.test.ts` still passes.

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime/server-state.ts src/server/runtime/stop-process.ts src/server/runtime/ServerService.ts tests/server/runtime/stop-process.test.ts tests/server/runtime/server-state.test.ts
git commit -m "fix(server): escalate stop to SIGKILL and report status by exit code"
```

---

### Task 2: `EmbeddedPostgresManager.stopExternal()`

**Files:**
- Modify: `src/server/runtime/EmbeddedPostgresManager.ts` (add a method after `stop()` at `:235`)
- Test: `tests/server/runtime/embedded-pg-stop-external.test.ts`

**Interfaces:**
- Produces:
  - `stopExternal(deps?: StopExternalDeps): Promise<StopExternalResult>`
  - `type StopExternalResult = 'not-running' | 'stopped' | 'foreign' | 'survived'`
  - `interface StopExternalDeps { kill?: (pid: number, signal: NodeJS.Signals) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; phaseWaitMs?: number }`

`postmaster.pid` format: line 1 is the PID, line 2 the data directory, line 4 the port. Ownership means both match this manager.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EmbeddedPostgresManager } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

function setup(opts: { pmDataDir?: string; pmPort?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'ms-pg-'));
  const dataDir = join(root, 'pgdata');
  const pidFile = join(root, 'local-pg.pid');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFile, '4242');
  writeFileSync(
    join(dataDir, 'postmaster.pid'),
    ['4242', opts.pmDataDir ?? dataDir, '1700000000', String(opts.pmPort ?? 55999), '/tmp', '127.0.0.1'].join('\n'),
  );
  const manager = new EmbeddedPostgresManager({ paths: { dataDir, pidFile, binariesDir: join(root, 'bin') }, port: 55999 });
  return { manager, pidFile };
}

function fakeProc(diesOn: NodeJS.Signals | null, startAlive = true) {
  let alive = startAlive;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    deps: {
      kill: (_p: number, s: NodeJS.Signals) => { signals.push(s); if (s === diesOn) alive = false; },
      isAlive: () => alive,
      sleep: async () => {},
      phaseWaitMs: 50,
    },
  };
}

// The old cross-process stop only deleted local-pg.pid, leaving postgres on the
// port; the next start then refused the port as foreign.
describe('EmbeddedPostgresManager.stopExternal', () => {
  it('signals postgres and removes local-pg.pid only after it exits', async () => {
    const { manager, pidFile } = setup({});
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('stopped');
    expect(p.signals).toEqual(['SIGTERM']);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('falls back to a fast shutdown when smart shutdown stalls', async () => {
    const { manager } = setup({});
    const p = fakeProc('SIGINT');
    expect(await manager.stopExternal(p.deps)).toBe('stopped');
    expect(p.signals).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('keeps local-pg.pid when postgres never exits', async () => {
    const { manager, pidFile } = setup({});
    expect(await manager.stopExternal(fakeProc(null).deps)).toBe('survived');
    expect(existsSync(pidFile)).toBe(true);
  });

  it('sends no signal to a postgres serving another data directory', async () => {
    const { manager } = setup({ pmDataDir: '/somewhere/else' });
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('foreign');
    expect(p.signals).toEqual([]);
  });

  it('sends no signal to a postgres on another port', async () => {
    const { manager } = setup({ pmPort: 55433 });
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('foreign');
    expect(p.signals).toEqual([]);
  });

  it('cleans up a dead postmaster without signalling', async () => {
    const { manager, pidFile } = setup({});
    const p = fakeProc(null, false);
    expect(await manager.stopExternal(p.deps)).toBe('not-running');
    expect(p.signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/server/runtime/embedded-pg-stop-external.test.ts`
Expected: FAIL with "manager.stopExternal is not a function".

- [ ] **Step 3: Implement `stopExternal()`**

Add near the top of the file, after the existing interfaces:

```ts
export type StopExternalResult = 'not-running' | 'stopped' | 'foreign' | 'survived';
export interface StopExternalDeps {
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  phaseWaitMs?: number;
}
```

Add inside the class, after `stop()`:

```ts
  // Stops a postgres started by another process (the server daemon). stop()
  // cannot: it only knows an in-process instance.
  async stopExternal(deps: StopExternalDeps = {}): Promise<StopExternalResult> {
    const kill = deps.kill ?? ((p, s) => process.kill(p, s));
    const isAlive = deps.isAlive ?? isPidAlive;
    const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const phaseWaitMs = deps.phaseWaitMs ?? 15_000;
    const removePidFile = () => { try { if (existsSync(this.paths.pidFile)) unlinkSync(this.paths.pidFile); } catch { /* best effort */ } };

    let lines: string[];
    try {
      lines = readFileSync(join(this.paths.dataDir, 'postmaster.pid'), 'utf8').split('\n').map((l) => l.trim());
    } catch {
      removePidFile();
      return 'not-running';
    }
    const pid = Number.parseInt(lines[0] ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
      removePidFile();
      return 'not-running';
    }
    if (lines[1] !== this.paths.dataDir || Number.parseInt(lines[3] ?? '', 10) !== this.port) {
      return 'foreign';
    }

    const exitedWithin = async (): Promise<boolean> => {
      for (let waited = 0; waited < phaseWaitMs; waited += 250) {
        if (!isAlive(pid)) return true;
        await sleep(250);
      }
      return !isAlive(pid);
    };

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      try { kill(pid, signal); } catch { /* exited between checks */ }
      if (await exitedWithin()) {
        removePidFile();
        return 'stopped';
      }
    }
    return 'survived';
  }
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/server/runtime/embedded-pg-stop-external.test.ts tests/server/runtime/embedded-pg-pid-adoption.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/EmbeddedPostgresManager.ts tests/server/runtime/embedded-pg-stop-external.test.ts
git commit -m "feat(local-runtime): stop embedded Postgres from another process"
```

---

### Task 3: Lifecycle module (`start`, `stop`, `restart`, `status`)

**Files:**
- Create: `src/npx-cli/commands/lifecycle.ts`
- Test: `tests/npx-cli/lifecycle.test.ts`

**Interfaces:**
- Consumes: `stopExternal()` (Task 2); `server-service.cjs stop` exit codes and `status` exit code (Task 1).
- Produces:
  - `resolveServerAddress(url: string): { host: string; port: number; baseUrl: string; remote: boolean }`
  - `type HealthResult = { reachable: false } | { reachable: true; httpStatus: number; initialized: boolean; version?: string; pid?: number; status?: string }`
  - `interface LifecycleDeps { runScript(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }>; probeHealth(baseUrl: string): Promise<HealthResult>; isAlive(pid: number): boolean; stopProcess(pid: number): Promise<'exited' | 'survived'>; stopPostgres(): Promise<'not-running' | 'stopped' | 'foreign' | 'survived'>; postgresRunning(): boolean; runtime(): 'local' | 'server'; pluginVersion(): string; serverUrl(): string; logPath(): string; sleep(ms: number): Promise<void>; now(): number; out(line: string): void; err(line: string): void }`
  - `runLifecycle(command: 'start' | 'stop' | 'restart' | 'status', argv: string[], deps?: LifecycleDeps): Promise<number>` — returns the exit code; the caller calls `process.exit`.
  - `defaultLifecycleDeps(): LifecycleDeps`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { resolveServerAddress, runLifecycle, type HealthResult, type LifecycleDeps } from '../../src/npx-cli/commands/lifecycle.js';

function deps(over: Partial<LifecycleDeps> & { health?: HealthResult[] } = {}) {
  const calls: { scripts: string[][]; envs: Record<string, string>[]; stopped: number[]; out: string[]; err: string[]; pgStops: number } =
    { scripts: [], envs: [], stopped: [], out: [], err: [], pgStops: 0 };
  const health = over.health ?? [{ reachable: false }];
  let clock = 0;
  const d: LifecycleDeps = {
    runScript: async (args, env) => {
      calls.scripts.push(args);
      calls.envs.push(env);
      return { code: 0, stdout: args[0] === 'start' ? '{"status":"starting","pid":777,"port":38900}\n' : '' };
    },
    probeHealth: async () => (health.length > 1 ? health.shift()! : health[0]),
    isAlive: () => true,
    stopProcess: async (pid) => { calls.stopped.push(pid); return 'exited'; },
    stopPostgres: async () => { calls.pgStops++; return 'stopped'; },
    postgresRunning: () => false,
    runtime: () => 'local',
    pluginVersion: () => '13.10.2',
    serverUrl: () => 'http://127.0.0.1:38900',
    logPath: () => '/tmp/memsmith.log',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    out: (l) => calls.out.push(l),
    err: (l) => calls.err.push(l),
    ...over,
  };
  return { d, calls };
}

const ready: HealthResult = { reachable: true, httpStatus: 200, initialized: true, version: '13.10.2', pid: 777, status: 'ok' };
const booting: HealthResult = { reachable: true, httpStatus: 200, initialized: false };

describe('resolveServerAddress', () => {
  it('treats loopback hosts as local and anything else as remote', () => {
    expect(resolveServerAddress('http://127.0.0.1:38879').remote).toBe(false);
    expect(resolveServerAddress('http://localhost:38879').remote).toBe(false);
    expect(resolveServerAddress('https://memsmith.example.com').remote).toBe(true);
  });
});

describe('start', () => {
  it('passes --daemon and the configured port to the server script', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.scripts[0]).toEqual(['start', '--daemon']);
    expect(calls.envs[0].MEMSMITH_SERVER_PORT).toBe('38900');
  });

  it('waits until the server reports initialized', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, booting, booting, ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.stopped).toEqual([]);
  });

  it('counts a degraded but initialized server as started, with a warning', async () => {
    const degraded: HealthResult = { reachable: true, httpStatus: 503, initialized: true, status: 'degraded' };
    const { d, calls } = deps({ health: [{ reachable: false }, degraded] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.err.join('\n')).toContain('degraded');
  });

  it('kills the spawned daemon and exits 1 on timeout', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, booting] });
    expect(await runLifecycle('start', ['--timeout', '2'], d)).toBe(1);
    expect(calls.stopped).toEqual([777]);
    expect(calls.err.join('\n')).toContain('/tmp/memsmith.log');
  });

  it('fails fast when the daemon dies before becoming healthy', async () => {
    let probes = 0;
    const { d, calls } = deps({
      probeHealth: async () => { probes++; return { reachable: false }; },
      isAlive: () => false,
    });
    expect(await runLifecycle('start', [], d)).toBe(1);
    expect(probes).toBeLessThanOrEqual(2);
    expect(calls.err.join('\n')).toContain('exited during startup');
  });

  it('reuses a running server without spawning', async () => {
    const { d, calls } = deps({ health: [ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.scripts).toEqual([]);
  });

  it('refuses to manage a remote server', async () => {
    const { d, calls } = deps({ serverUrl: () => 'https://team.example.com' });
    expect(await runLifecycle('start', [], d)).toBe(1);
    expect(calls.scripts).toEqual([]);
  });
});

describe('stop', () => {
  it('stops the server and leaves Postgres running by default', async () => {
    const { d, calls } = deps();
    expect(await runLifecycle('stop', [], d)).toBe(0);
    expect(calls.scripts[0]).toEqual(['stop']);
    expect(calls.pgStops).toBe(0);
  });

  it('also stops Postgres with --all, after the server', async () => {
    const { d, calls } = deps();
    expect(await runLifecycle('stop', ['--all'], d)).toBe(0);
    expect(calls.scripts[0]).toEqual(['stop']);
    expect(calls.pgStops).toBe(1);
  });

  it('fails when the port still answers after stop', async () => {
    const { d } = deps({ health: [ready] });
    expect(await runLifecycle('stop', [], d)).toBe(1);
  });

  it('fails --all when Postgres survives', async () => {
    const { d } = deps({ stopPostgres: async () => 'survived' });
    expect(await runLifecycle('stop', ['--all'], d)).toBe(1);
  });
});

describe('status', () => {
  it('exits 1 when nothing answers', async () => {
    const { d } = deps();
    expect(await runLifecycle('status', [], d)).toBe(1);
  });

  it('exits 0 and prints the server and plugin versions when running', async () => {
    const { d, calls } = deps({ health: [ready] });
    expect(await runLifecycle('status', [], d)).toBe(0);
    const text = calls.out.join('\n');
    expect(text).toContain('13.10.2');
    expect(text).toContain('http://127.0.0.1:38900');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/npx-cli/lifecycle.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `lifecycle.ts`**

```ts
import { existsSync } from 'fs';
import { join } from 'path';
import { parseArgs, styleText } from 'node:util';
import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { getBunPath } from '../install/setup-runtime.js';
import { isPluginInstalled, marketplaceDirectory, readPluginVersion } from '../utils/paths.js';

export type LifecycleCommand = 'start' | 'stop' | 'restart' | 'status';

export type HealthResult =
  | { reachable: false }
  | { reachable: true; httpStatus: number; initialized: boolean; version?: string; pid?: number; status?: string };

export interface LifecycleDeps {
  runScript(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }>;
  probeHealth(baseUrl: string): Promise<HealthResult>;
  isAlive(pid: number): boolean;
  stopProcess(pid: number): Promise<'exited' | 'survived'>;
  stopPostgres(): Promise<'not-running' | 'stopped' | 'foreign' | 'survived'>;
  postgresRunning(): boolean;
  runtime(): 'local' | 'server';
  pluginVersion(): string;
  serverUrl(): string;
  logPath(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(line: string): void;
  err(line: string): void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const POLL_MS = 500;
const DEFAULT_TIMEOUT_S = 300;

export function resolveServerAddress(url: string): { host: string; port: number; baseUrl: string; remote: boolean } {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return {
    host: parsed.hostname,
    port,
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    remote: !LOOPBACK.has(parsed.hostname),
  };
}

function parseDaemonPid(stdout: string): number | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const pid = (JSON.parse(line) as { pid?: unknown }).pid;
      if (typeof pid === 'number') return pid;
    } catch { /* not the JSON line */ }
  }
  return null;
}

async function start(argv: string[], d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { timeout: { type: 'string' } }, strict: false });
  const timeoutS = Number(values.timeout ?? DEFAULT_TIMEOUT_S);

  const existing = await d.probeHealth(addr.baseUrl);
  if (existing.reachable) {
    d.out(`Server is already running at ${addr.baseUrl}`);
    return 0;
  }

  const result = await d.runScript(['start', '--daemon'], { MEMSMITH_SERVER_PORT: String(addr.port) });
  if (result.code !== 0) {
    d.err(`Server failed to start. Log: ${d.logPath()}`);
    return 1;
  }
  const pid = parseDaemonPid(result.stdout);

  const deadline = d.now() + timeoutS * 1000;
  while (d.now() < deadline) {
    const health = await d.probeHealth(addr.baseUrl);
    if (health.reachable && health.initialized) {
      if (health.httpStatus === 503) d.err(`Server started but reports degraded: ${health.status ?? 'unknown'}`);
      d.out(`Server is running at ${addr.baseUrl}`);
      return 0;
    }
    if (pid !== null && !d.isAlive(pid)) {
      d.err(`Server exited during startup. Log: ${d.logPath()}`);
      return 1;
    }
    await d.sleep(POLL_MS);
  }

  if (pid !== null) await d.stopProcess(pid);
  d.err(`Server did not become ready within ${timeoutS}s and was stopped. Log: ${d.logPath()}`);
  return 1;
}

async function stop(argv: string[], d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const all = argv.includes('--all');
  const result = await d.runScript(['stop'], { MEMSMITH_SERVER_PORT: String(addr.port) });
  if (result.code !== 0) return 1;
  if ((await d.probeHealth(addr.baseUrl)).reachable) {
    d.err(`Something still answers at ${addr.baseUrl}. Check it with: lsof -nP -iTCP:${addr.port} -sTCP:LISTEN`);
    return 1;
  }
  if (!all || d.runtime() !== 'local') return 0;
  const pg = await d.stopPostgres();
  if (pg === 'survived') {
    d.err('Embedded Postgres did not exit.');
    return 1;
  }
  if (pg === 'foreign') {
    d.err('The Postgres on MEMSMITH_LOCAL_PG_PORT belongs to another data directory; left it running.');
    return 1;
  }
  d.out(pg === 'stopped' ? 'Embedded Postgres stopped' : 'Embedded Postgres was not running');
  return 0;
}

async function status(d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const health = await d.probeHealth(addr.baseUrl);
  const runtime = d.runtime();
  const pgLine = runtime === 'local' ? `  Postgres:  ${d.postgresRunning() ? 'running' : 'stopped'}` : null;
  if (!health.reachable) {
    d.out('Server is not running');
    if (pgLine) d.out(pgLine);
    return 1;
  }
  d.out(health.initialized ? 'Server is running' : 'Server is starting');
  d.out(`  PID:       ${health.pid ?? 'unknown'}`);
  d.out(`  Address:   ${addr.baseUrl}`);
  d.out(`  Runtime:   ${runtime} (as selected for the plugin directory)`);
  d.out(`  Version:   ${health.version ?? 'unknown'} (plugin ${d.pluginVersion()})`);
  d.out(`  Dashboard: ${addr.baseUrl}`);
  if (pgLine) d.out(pgLine);
  return 0;
}

export async function runLifecycle(
  command: LifecycleCommand,
  argv: string[],
  d: LifecycleDeps = defaultLifecycleDeps(),
): Promise<number> {
  const addr = resolveServerAddress(d.serverUrl());
  if (addr.remote) {
    d.err(`MEMSMITH_SERVER_URL points at a remote server (${addr.baseUrl}). Lifecycle commands manage only a local server.`);
    return 1;
  }
  switch (command) {
    case 'start': return start(argv, d, addr);
    case 'stop': return stop(argv, d, addr);
    case 'status': return status(d, addr);
    case 'restart': {
      const stopped = await stop([], d, addr);
      return stopped === 0 ? start(argv, d, addr) : stopped;
    }
  }
}
```

Add `defaultLifecycleDeps()` in the same file. It exits through `ensureInstalledOrExit` behavior when the plugin or Bun is missing:

```ts
function serverScriptPath(): string {
  const scriptsDir = join(marketplaceDirectory(), 'plugin', 'scripts');
  const renamed = join(scriptsDir, 'server-service.cjs');
  return existsSync(renamed) ? renamed : join(scriptsDir, 'server-beta-service.cjs');
}

export function defaultLifecycleDeps(): LifecycleDeps {
  const fail = (message: string): never => {
    console.error(styleText('red', message));
    process.exit(1);
  };
  return {
    runScript: (args, env) => new Promise((resolve) => {
      if (!isPluginInstalled()) fail('memsmith is not installed. Run: npx memsmith install');
      const bun = getBunPath() ?? fail('Bun not found. Install Bun: https://bun.sh');
      const script = serverScriptPath();
      if (!existsSync(script)) fail(`Server script not found at: ${script}. Try: npx memsmith repair`);
      const child = spawnHidden(bun, [script, ...args], {
        cwd: marketplaceDirectory(),
        env: { ...sanitizeEnv(process.env), ...env },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.on('error', (error) => fail(`Failed to start Bun: ${error.message}`));
      child.on('close', (code) => resolve({ code: code ?? 0, stdout }));
    }),
    probeHealth: async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          reachable: true,
          httpStatus: res.status,
          initialized: body.initialized === true,
          version: typeof body.version === 'string' ? body.version : undefined,
          pid: typeof body.pid === 'number' ? body.pid : undefined,
          status: typeof body.status === 'string' ? body.status : undefined,
        };
      } catch {
        return { reachable: false };
      }
    },
    isAlive: isPidAlive,
    stopProcess: async (pid) => (await import('../../server/runtime/stop-process.js')).stopProcess(pid),
    stopPostgres: () => new EmbeddedPostgresManager().stopExternal(),
    postgresRunning: () => new EmbeddedPostgresManager().isRunning(),
    runtime: () => selectRuntime(marketplaceDirectory()),
    pluginVersion: readPluginVersion,
    serverUrl: () => SettingsDefaultsManager.get('MEMSMITH_SERVER_URL'),
    logPath: () => join(paths.logsDir(), `memsmith-${new Date().toISOString().slice(0, 10)}.log`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(styleText('yellow', line)),
  };
}
```

Add these static imports at the top of `lifecycle.ts`:

```ts
import { EmbeddedPostgresManager } from '../../server/runtime/EmbeddedPostgresManager.js';
import { selectRuntime } from '../../services/hooks/runtime-selector.js';
```

`EmbeddedPostgresManager` loads `@boomship/postgres-vector-embedded` lazily, so the static import doesn't pull the native package into the CLI's startup path. Verify that `npm run build` bundles both imports without errors.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/npx-cli/lifecycle.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/npx-cli/commands/lifecycle.ts tests/npx-cli/lifecycle.test.ts
git commit -m "feat(cli): add start, stop, restart, and status that wait and verify"
```

---

### Task 4: Route every lifecycle entry point to `lifecycle.ts`

**Files:**
- Modify: `src/npx-cli/index.ts` (cases `start`, `stop`, `restart`, `status` at `:144-163`; help text at `:36-49`)
- Modify: `src/npx-cli/commands/server.ts` (`runServerLifecycleCommand`, `runWorkerLifecycleCommand`, `runWorkerAliasCommand`)
- Modify: `src/npx-cli/commands/runtime.ts` (delete `runStartCommand`, `runStopCommand`, `runRestartCommand`, `runStatusCommand`, `runServerStartCommand`, `runServerStopCommand`, `runServerRestartCommand`, `runServerStatusCommand`)
- Replace: `tests/npx-cli-server-namespace.test.ts` with `tests/npx-cli/lifecycle-routing.test.ts`

**Interfaces:**
- Consumes: `runLifecycle(command, argv, deps?)` (Task 3).
- Produces: `routeLifecycle(namespace: 'top' | 'server' | 'worker', argv: string[], deps?: LifecycleDeps): Promise<number | null>` in `server.ts` — returns `null` when `argv[0]` is not a lifecycle command.

- [ ] **Step 1: Write the failing routing test**

`tests/npx-cli/lifecycle-routing.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { routeLifecycle } from '../../src/npx-cli/commands/server.js';
import type { LifecycleDeps } from '../../src/npx-cli/commands/lifecycle.js';

function recorder() {
  const scripts: string[][] = [];
  const d = {
    runScript: async (args: string[]) => { scripts.push(args); return { code: 0, stdout: '{"pid":1}' }; },
    probeHealth: async () => (scripts.length ? { reachable: true, httpStatus: 200, initialized: true } : { reachable: false }),
    isAlive: () => true,
    stopProcess: async () => 'exited',
    stopPostgres: async () => 'stopped',
    postgresRunning: () => false,
    runtime: () => 'local',
    pluginVersion: () => '0',
    serverUrl: () => 'http://127.0.0.1:38900',
    logPath: () => '/tmp/log',
    sleep: async () => {},
    now: () => 0,
    out: () => {},
    err: () => {},
  } as unknown as LifecycleDeps;
  return { d, scripts };
}

// Observed 2026-10-13: `memsmith stop` and `memsmith worker stop` called the
// removed worker-service.cjs, and `server start` ran without --daemon.
describe('lifecycle routing', () => {
  for (const ns of ['top', 'server', 'worker'] as const) {
    it(`${ns} start runs server-service start --daemon`, async () => {
      const { d, scripts } = recorder();
      await routeLifecycle(ns, ['start'], d);
      expect(scripts[0]).toEqual(['start', '--daemon']);
    });

    it(`${ns} stop runs server-service stop`, async () => {
      const { d, scripts } = recorder();
      await routeLifecycle(ns, ['stop'], d);
      expect(scripts[0]).toEqual(['stop']);
    });
  }

  it('returns null for a non-lifecycle subcommand so the caller can handle it', async () => {
    const { d } = recorder();
    expect(await routeLifecycle('server', ['api-key'], d)).toBeNull();
  });
});
```

Also add an `api-key` routing check. Today `runServerApiKeyCommand` calls `spawnBunWorkerCommand('server', ['api-key', …])`, which runs the missing `worker-service.cjs`. In `src/npx-cli/commands/runtime.ts`, split argument building from spawning so the test needs no install or Bun:

```ts
export function serverApiKeyArgs(extraArgs: string[]): string[] {
  return ['server', 'api-key', ...extraArgs];
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  const [command, ...rest] = serverApiKeyArgs(extraArgs);
  spawnBunServerCommand(command, rest);
}
```

Test, in the same file:

```ts
import { serverApiKeyArgs } from '../../src/npx-cli/commands/runtime.js';

it('server api-key list keeps the server prefix that server-service dispatches on', () => {
  expect(serverApiKeyArgs(['list'])).toEqual(['server', 'api-key', 'list']);
});
```

`server-service.cjs` handles `argv[0] === 'server' && argv[1] === 'api-key'` (`ServerService.ts:682`); without the prefix it prints usage and exits 1.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/npx-cli/lifecycle-routing.test.ts`
Expected: FAIL with "routeLifecycle is not exported".

- [ ] **Step 3: Implement `routeLifecycle` and rewire**

In `src/npx-cli/commands/server.ts`, replace `runWorkerLifecycleCommand` and `runServerLifecycleCommand` with:

```ts
import { runLifecycle, type LifecycleCommand, type LifecycleDeps } from './lifecycle.js';

const LIFECYCLE = new Set<LifecycleCommand>(['start', 'stop', 'restart', 'status']);

export async function routeLifecycle(
  namespace: 'top' | 'server' | 'worker',
  argv: string[],
  deps?: LifecycleDeps,
): Promise<number | null> {
  const sub = argv[0]?.toLowerCase() as LifecycleCommand | undefined;
  if (!sub || !LIFECYCLE.has(sub)) return null;
  if (namespace === 'worker') console.error(styleText('yellow', '`memsmith worker` is deprecated; use `memsmith ' + sub + '`.'));
  return runLifecycle(sub, argv.slice(1), deps);
}
```

In `runServerCommand`, replace `if (runServerLifecycleCommand(subCommand)) return;` with:

```ts
  const lifecycleCode = await routeLifecycle('server', argv);
  if (lifecycleCode !== null) process.exit(lifecycleCode);
```

Replace `runWorkerAliasCommand` with an async version:

```ts
export async function runWorkerAliasCommand(argv: string[] = []): Promise<void> {
  const code = await routeLifecycle('worker', argv);
  if (code === null) {
    console.error(styleText('red', `Unknown worker command: ${argv[0] ?? '(none)'}`));
    console.error('Usage: memsmith worker start|stop|restart|status');
    process.exit(1);
  }
  process.exit(code);
}
```

Remove the now-unused imports from `server.ts`. Update `printServerUsage` to list `stop [--all]` and `start [--timeout <s>]`.

In `src/npx-cli/index.ts`, replace the four top-level cases with one:

```ts
    case 'start':
    case 'stop':
    case 'restart':
    case 'status': {
      const { routeLifecycle } = await import('./commands/server.js');
      process.exit((await routeLifecycle('top', args)) ?? 1);
    }
```

Change the `worker` case to `await runWorkerAliasCommand(args.slice(1));`.

Replace the runtime block of `printHelp()` with:

```ts
${styleText('bold', 'Server Commands')} (requires Bun, delegates to installed plugin):
  ${styleText('cyan', 'memsmith start [--timeout <s>]')}    Start the local server and wait until it is ready
  ${styleText('cyan', 'memsmith stop [--all]')}             Stop the server (--all also stops embedded Postgres)
  ${styleText('cyan', 'memsmith restart')}                  Restart the server
  ${styleText('cyan', 'memsmith status')}                   Show server status (exit 1 when not running)
  ${styleText('cyan', 'memsmith doctor [--fix]')}           Diagnose, and optionally repair, the install
  ${styleText('cyan', 'memsmith server api-key create|list|revoke')}   Manage API keys
```

Keep the existing `telemetry`, `search`, `adopt`, `cleanup`, `transcript`, and `antigravity-cli` lines. Remove the `server start|stop|restart|status` and `worker ...` lines; the aliases still work.

In `runtime.ts`, delete the eight lifecycle functions listed under **Files**. Keep `spawnBunWorkerCommand` and `workerServiceScriptPath`; `adopt`, `cleanup`, and `transcript watch` still use them.

Delete `tests/npx-cli-server-namespace.test.ts`.

- [ ] **Step 4: Run tests, typecheck, and build**

Run: `bun test tests/npx-cli/ && npx tsc --noEmit && npm run build`
Expected: PASS, no type errors, build succeeds.

Then, against your real install: `node dist/npx-cli/index.js status` prints the running server and exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A src/npx-cli tests/npx-cli tests/npx-cli-server-namespace.test.ts
git commit -m "fix(cli): route start, stop, restart, and status to the server"
```

---

### Task 5: Installer auto-start

**Files:**
- Modify: `src/npx-cli/commands/install.ts:1690-1731`
- Test: `tests/npx-cli/install-autostart.test.ts`

**Interfaces:**
- Produces: `buildAutoStartCommand(input: { runtimePath: string; scriptPath: string; useSetsid: boolean }): { execPath: string; args: string[] }` exported from `install.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test';
import { buildAutoStartCommand } from '../../src/npx-cli/commands/install.js';

// Install auto-start ran `worker-service.cjs local start`, a script that no
// longer ships and a command server-service does not have.
describe('install auto-start', () => {
  it('runs server-service start --daemon', () => {
    expect(buildAutoStartCommand({ runtimePath: '/bun', scriptPath: '/p/server-service.cjs', useSetsid: false }))
      .toEqual({ execPath: '/bun', args: ['/p/server-service.cjs', 'start', '--daemon'] });
  });

  it('wraps the same command in setsid when available', () => {
    expect(buildAutoStartCommand({ runtimePath: '/bun', scriptPath: '/p/server-service.cjs', useSetsid: true }))
      .toEqual({ execPath: '/usr/bin/setsid', args: ['/bun', '/p/server-service.cjs', 'start', '--daemon'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/npx-cli/install-autostart.test.ts`
Expected: FAIL with "buildAutoStartCommand is not exported".

Importing `install.ts` runs its top-level code. If the import has side effects that break the test (for example, a prompt), move `buildAutoStartCommand` into `src/npx-cli/install/autostart.ts` instead and import it from there in both places.

- [ ] **Step 3: Implement**

```ts
export function buildAutoStartCommand(input: { runtimePath: string; scriptPath: string; useSetsid: boolean }): { execPath: string; args: string[] } {
  const command = [input.scriptPath, 'start', '--daemon'];
  return input.useSetsid
    ? { execPath: '/usr/bin/setsid', args: [input.runtimePath, ...command] }
    : { execPath: input.runtimePath, args: command };
}
```

In the auto-start task, replace the `worker-service.cjs` path lookup and the `args` construction:

```ts
        const marketplaceScriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'server-service.cjs');
        const cacheScriptPath = join(pluginCacheDirectory(version), 'scripts', 'server-service.cjs');
        const scriptPath = existsSync(marketplaceScriptPath) ? marketplaceScriptPath : cacheScriptPath;
        message('Starting the local server in the background...');
        const runtimePath = resolveWorkerRuntimePath();
        if (!runtimePath) {
          workerStartResult = 'dead';
          return `Bun runtime not found — install from https://bun.sh ${styleText('yellow', '!')}`;
        }
        const { execPath, args } = buildAutoStartCommand({
          runtimePath,
          scriptPath,
          useSetsid: process.platform !== 'win32' && existsSync('/usr/bin/setsid'),
        });
        const child = spawnHidden(execPath, args, { detached: true, stdio: 'ignore' });
        if (child.pid === undefined) {
          workerStartResult = 'dead';
          return `Local server did not start — run ${styleText('bold', 'memsmith start')} ${styleText('yellow', '!')}`;
        }
        child.unref();
        workerStartResult = 'warming';
        return `Local server starting in the background — check it with ${styleText('bold', 'memsmith status')} ${styleText('yellow', '⏳')}`;
```

Change the server-runtime message at `:1695` from `npx memsmith server start` to `memsmith start`. Change the `--no-auto-start` help line in `index.ts` from "Skip worker auto-start" to "Skip server auto-start".

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test tests/npx-cli/install-autostart.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/npx-cli/commands/install.ts src/npx-cli/index.ts tests/npx-cli/install-autostart.test.ts
git commit -m "fix(install): auto-start the server script that actually ships"
```

---

### Task 6: `doctor` server check and `doctor --fix`

**Files:**
- Modify: `src/npx-cli/commands/doctor.ts`
- Modify: `src/npx-cli/commands/install.ts` (export `installMarketplaceDependencies`; call it from `runRepairCommand`)
- Modify: `src/npx-cli/index.ts` (`doctor` case passes `args.slice(1)`)
- Test: `tests/npx-cli/doctor-fix.test.ts`

**Interfaces:**
- Consumes: `runLifecycle` (Task 3), `readServerPidFile` and `removeServerState` (Task 1), `resolveServerAddress` (Task 3).
- Produces:
  - `installMarketplaceDependencies(): Promise<void>` in `install.ts`.
  - `planRepairs(state: DoctorState): Repair[]` where `DoctorState = { pidFileStale: boolean; portInUse: boolean; depsMissing: boolean; serverReachable: boolean; serverVersion?: string; pluginVersion: string; remote: boolean }` and `type Repair = 'remove-stale-state' | 'install-deps' | 'restart' | 'start'`.
  - `applyRepairs(repairs: Repair[], deps: RepairDeps): Promise<{ ok: true } | { ok: false; failed: Repair; error: string }>` where `RepairDeps = { removeState(): void; installDeps(): Promise<void>; lifecycle(cmd: 'start' | 'restart'): Promise<number>; out(line: string): void }`.
  - `runDoctorCommand(argv?: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'bun:test';
import { applyRepairs, planRepairs, type DoctorState } from '../../src/npx-cli/commands/doctor.js';

const healthy: DoctorState = {
  pidFileStale: false, portInUse: true, depsMissing: false,
  serverReachable: true, serverVersion: '13.10.2', pluginVersion: '13.10.2', remote: false,
};

describe('planRepairs', () => {
  it('plans nothing for a healthy install', () => {
    expect(planRepairs(healthy)).toEqual([]);
  });

  it('removes stale state only when nothing listens on the port', () => {
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: false, serverReachable: false }))
      .toEqual(['remove-stale-state', 'start']);
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: true })).not.toContain('remove-stale-state');
  });

  it('restarts a server running an older version', () => {
    expect(planRepairs({ ...healthy, serverVersion: '13.10.1' })).toEqual(['restart']);
  });

  it('installs missing dependencies before starting', () => {
    expect(planRepairs({ ...healthy, depsMissing: true, serverReachable: false, portInUse: false }))
      .toEqual(['install-deps', 'start']);
  });

  it('plans no server repair for a remote server', () => {
    expect(planRepairs({ ...healthy, remote: true, serverReachable: false })).toEqual([]);
  });
});

describe('applyRepairs', () => {
  it('stops at the first failed repair and names it', async () => {
    const ran: string[] = [];
    const result = await applyRepairs(['install-deps', 'start'], {
      removeState: () => ran.push('remove'),
      installDeps: async () => { ran.push('deps'); throw new Error('npm failed'); },
      lifecycle: async (c) => { ran.push(c); return 0; },
      out: () => {},
    });
    expect(result).toEqual({ ok: false, failed: 'install-deps', error: 'npm failed' });
    expect(ran).toEqual(['deps']);
  });

  it('treats a nonzero lifecycle exit as a failure', async () => {
    const result = await applyRepairs(['start'], {
      removeState: () => {}, installDeps: async () => {}, lifecycle: async () => 1, out: () => {},
    });
    expect(result).toMatchObject({ ok: false, failed: 'start' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/npx-cli/doctor-fix.test.ts`
Expected: FAIL with "planRepairs is not exported".

- [ ] **Step 3: Implement**

In `install.ts`, add:

```ts
export async function installMarketplaceDependencies(): Promise<void> {
  await runNpmInstallInMarketplace(createInstallSummary());
}
```

Import `createInstallSummary` from `../install/error-reporter.js` if it is not already imported. In `runRepairCommand`, after `installPluginDependencies(cacheDir, bunPath)`, add:

```ts
        message('Reinstalling marketplace dependencies…');
        await installMarketplaceDependencies();
```

In `doctor.ts`, add:

```ts
export type Repair = 'remove-stale-state' | 'install-deps' | 'restart' | 'start';
export interface DoctorState {
  pidFileStale: boolean; portInUse: boolean; depsMissing: boolean;
  serverReachable: boolean; serverVersion?: string; pluginVersion: string; remote: boolean;
}
export interface RepairDeps {
  removeState(): void;
  installDeps(): Promise<void>;
  lifecycle(cmd: 'start' | 'restart'): Promise<number>;
  out(line: string): void;
}

export function planRepairs(s: DoctorState): Repair[] {
  const repairs: Repair[] = [];
  if (!s.remote && s.pidFileStale && !s.portInUse) repairs.push('remove-stale-state');
  if (s.depsMissing) repairs.push('install-deps');
  if (s.remote) return repairs;
  if (!s.serverReachable) repairs.push('start');
  else if (s.serverVersion && s.serverVersion !== s.pluginVersion) repairs.push('restart');
  return repairs;
}

export async function applyRepairs(
  repairs: Repair[],
  deps: RepairDeps,
): Promise<{ ok: true } | { ok: false; failed: Repair; error: string }> {
  for (const repair of repairs) {
    deps.out(`Fixing: ${repair}`);
    try {
      if (repair === 'remove-stale-state') deps.removeState();
      else if (repair === 'install-deps') await deps.installDeps();
      else if ((await deps.lifecycle(repair)) !== 0) return { ok: false, failed: repair, error: `memsmith ${repair} failed` };
    } catch (error) {
      return { ok: false, failed: repair, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true };
}
```

Restructure `runDoctorCommand(argv: string[] = [])`:

1. Move the existing check-building code into `async function collectChecks(fix: boolean): Promise<{ checks: CheckResult[]; state: DoctorState }>`.
2. Replace check 5 ("Worker daemon") with a "Server" check. Resolve the address with `resolveServerAddress(SettingsDefaultsManager.get('MEMSMITH_SERVER_URL'))`. Probe `${baseUrl}/api/health` with a 3-second timeout. Status `ok` when reachable and versions match; `warn` with "running {serverVersion}, plugin is {pluginVersion} — run `memsmith restart`" on a mismatch; `fail` with "not running — run `memsmith start` or `memsmith doctor --fix`" when unreachable; `warn` with "remote server at {baseUrl}; not managed by doctor" when remote. `required: fix` so a failed server check fails `--fix`.
3. Fill `DoctorState`: `pidFileStale` is `readServerPidFile() !== null && !verifyPidFileOwnership(readServerPidFile())`; `portInUse` is whether a TCP connect to the address succeeds; `depsMissing` is the existing `installed && !depsPresent`.
4. Update remediation strings: `npx memsmith repair` stays; `npx memsmith start` becomes `memsmith start`.
5. When `argv.includes('--fix')`: print the checks, call `planRepairs`, then `applyRepairs` with:

   ```ts
   {
     removeState: () => removeServerState(),
     installDeps: async () => (await import('./install.js')).installMarketplaceDependencies(),
     lifecycle: async (cmd) => (await import('./lifecycle.js')).runLifecycle(cmd, []),
     out: (line) => console.log(styleText('cyan', `  → ${line}`)),
   }
   ```

   On failure, print `Repair failed at {failed}: {error}` and exit 1. On success, collect the checks again with `fix = true`, print them, and exit with the result.
6. Without `--fix`, behavior and exit codes stay as they are today.
7. Update the file header comment: it is read-only unless `--fix` is passed.

In `index.ts`, change the `doctor` case to `await runDoctorCommand(args.slice(1));`.

- [ ] **Step 4: Run the tests, typecheck, and try it**

Run: `bun test tests/npx-cli/doctor-fix.test.ts && npx tsc --noEmit && npm run build && node dist/npx-cli/index.js doctor`
Expected: tests PASS; doctor shows a "Server" line for port 38879.

- [ ] **Step 5: Commit**

```bash
git add src/npx-cli/commands/doctor.ts src/npx-cli/commands/install.ts src/npx-cli/index.ts tests/npx-cli/doctor-fix.test.ts
git commit -m "feat(doctor): check the server and repair common failures with --fix"
```

---

### Task 7: Remove the dead local CLI and update docs

**Files:**
- Delete: `src/services/local-runtime-cli.ts`, `tests/services/local-runtime-cli.test.ts`
- Modify: `tests/logger-usage-standards.test.ts:35` (remove the `local-runtime-cli` allowlist line)
- Modify: `CLAUDE.md:30`
- Modify: `README.md` (quick start, note at line 48, new section)

- [ ] **Step 1: Confirm there are no other callers**

Run: `grep -rn "local-runtime-cli" src scripts plugin/hooks tests`
Expected: only the two files being deleted and the allowlist line.

- [ ] **Step 2: Delete and update**

Delete the two files and the allowlist line.

In `CLAUDE.md`, replace line 30 with:

```markdown
  - Manage it with `memsmith start | stop [--all] | restart | status` (`src/npx-cli/commands/lifecycle.ts`). `stop` leaves embedded Postgres running; `stop --all` stops it too.
```

In `README.md`, make the quick start:

````markdown
## Quick start

Install with a single command:

```bash
npx memsmith install
```

Or install from the plugin marketplace inside Claude Code:

```bash
/plugin marketplace add shshalom/memsmith
/plugin install memsmith
```

Restart Claude Code. Context from previous sessions appears in new sessions, and
the dashboard is available at http://localhost:38879.

> **Note:** `npm install -g memsmith` installs the `memsmith` CLI only. To
> register the plugin hooks and set up the server, run `memsmith install`.

## Manage the server

| Command | What it does |
| --- | --- |
| `memsmith start` | Starts the local server and waits until it is ready. |
| `memsmith stop` | Stops the server. Embedded Postgres keeps running so the next start is fast. |
| `memsmith stop --all` | Stops the server and embedded Postgres. |
| `memsmith restart` | Restarts the server. |
| `memsmith status` | Shows the server's state and version. Exits 1 when it is not running. |
| `memsmith doctor` | Checks Bun, uv, the plugin install, and the server. |
| `memsmith doctor --fix` | Also repairs stale state, missing dependencies, and a stopped or outdated server. |

Without a global install, prefix each command with `npx`, for example
`npx memsmith status`.
````

- [ ] **Step 3: Run the affected tests**

Run: `bun test tests/logger-usage-standards.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A src/services/local-runtime-cli.ts tests/services/local-runtime-cli.test.ts tests/logger-usage-standards.test.ts CLAUDE.md README.md
git commit -m "docs: document npm install and server commands; remove dead local CLI"
```

---

### Task 8: Clean-room smoke test

**Files:**
- Create: `scripts/smoke-clean-room.mjs`
- Modify: `package.json` (add `"smoke:clean-room": "node scripts/smoke-clean-room.mjs"`; add `smoke-artifacts/` to `.gitignore`)

**Interfaces:**
- Consumes: the `memsmith` CLI from Tasks 3–5 as packed by `npm pack`.

The script is itself the test. It must fail on today's `main`: there, `memsmith start` calls the missing `worker-service.cjs`.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const serverPort = process.env.SMOKE_SERVER_PORT ?? '38990';
const pgPort = process.env.SMOKE_PG_PORT ?? '55490';
const deadline = Date.now() + 15 * 60 * 1000;

const home = mkdtempSync(join(tmpdir(), 'memsmith-smoke-'));
const prefix = join(home, 'npm-global');
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  MEMSMITH_DATA_DIR: join(home, '.memsmith'),
  MEMSMITH_SERVER_PORT: serverPort,
  MEMSMITH_SERVER_URL: `http://127.0.0.1:${serverPort}`,
  MEMSMITH_LOCAL_PG_PORT: pgPort,
  npm_config_prefix: prefix,
  PATH: `${join(prefix, 'bin')}:${process.env.PATH}`,
};

function step(name, cmd, args, expectCode = 0) {
  if (Date.now() > deadline) throw new Error(`smoke timed out before: ${name}`);
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: deadline - Date.now() });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== expectCode) throw new Error(`${name}: expected exit ${expectCode}, got ${r.status}`);
  return r.stdout ?? '';
}

function portFree(port) {
  return new Promise((done) => {
    const s = net.connect({ port: Number(port), host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); done(false); });
    s.once('error', () => done(true));
  });
}

let failed = false;
try {
  execFileSync('bun', ['--version'], { stdio: 'ignore' });
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop();
  step('install tarball', 'npm', ['install', '-g', join(home, tarball)]);
  step('memsmith install', 'memsmith', ['install', '--no-auto-start', '--ide', 'claude-code']);
  step('memsmith start', 'memsmith', ['start']);
  const status = step('memsmith status (running)', 'memsmith', ['status']);
  if (!status.includes(version)) throw new Error(`status does not report version ${version}`);
  step('memsmith stop --all', 'memsmith', ['stop', '--all']);
  step('memsmith status (stopped)', 'memsmith', ['status'], 1);
  for (const port of [serverPort, pgPort]) {
    if (!(await portFree(port))) throw new Error(`port ${port} still has a listener`);
  }
  console.log('\n✓ clean-room smoke passed');
} catch (error) {
  failed = true;
  console.error(`\n✗ ${error.message}`);
  const logs = join(home, '.memsmith', 'logs');
  if (existsSync(logs)) {
    mkdirSync(join(repo, 'smoke-artifacts'), { recursive: true });
    for (const f of readdirSync(logs)) cpSync(join(logs, f), join(repo, 'smoke-artifacts', f));
  }
} finally {
  spawnSync('memsmith', ['stop', '--all'], { env, stdio: 'ignore', timeout: 60_000 });
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Verify it fails on `main`**

Run: `git stash -u && git switch main && npm run build && node <path-to-this-script-copy> ; git switch - && git stash pop`
Copy the script to `/tmp` first, because `main` doesn't have it.
Expected: FAIL at `memsmith start` (missing `worker-service.cjs`) or at `install tarball`.

- [ ] **Step 3: Run it on this branch**

Run: `npm run build && npm run smoke:clean-room`
Expected: `✓ clean-room smoke passed`. Your server on 38879 and Postgres on 55433 are untouched: check with `lsof -nP -iTCP:38879 -sTCP:LISTEN` before and after.

If `memsmith install` prompts or fails in non-TTY mode, fix the cause in `install.ts` in this task. Don't weaken the smoke test.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-clean-room.mjs package.json .gitignore
git commit -m "test(release): add a clean-room install and lifecycle smoke test"
```

---

### Task 9: Trusted publishing workflow

**Files:**
- Modify: `.github/workflows/npm-publish.yml`

- [ ] **Step 1: Replace the workflow**

```yaml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      dry_run:
        description: Run every step except npm publish
        type: boolean
        default: true
  schedule:
    - cron: '17 6 * * *'

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm install -g npm@^11.5.1
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Check tag matches package.json
        if: github.ref_type == 'tag'
        run: |
          pkg="$(node -p "require('./package.json').version")"
          tag="${GITHUB_REF_NAME#v}"
          if [ "$pkg" != "$tag" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $pkg"
            exit 1
          fi
      - run: npm install --ignore-scripts
      - run: npm run build
      - run: npm run smoke:clean-room
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: smoke-artifacts
          path: smoke-artifacts/
      - name: Publish
        if: github.ref_type == 'tag' && github.event_name == 'push'
        run: npm publish --provenance
```

Scheduled and manual runs never publish: the `Publish` step runs only for a pushed tag. The `dry_run` input documents intent for manual runs.

- [ ] **Step 2: Validate the YAML**

Run: `npx --yes @action-validator/cli .github/workflows/npm-publish.yml` (or `actionlint` if installed).
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/npm-publish.yml
git commit -m "ci(release): publish from tags with npm trusted publishing"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — no errors.
- [ ] `npm run build` — succeeds.
- [ ] `bun test` — the full suite passes, or any failures are confirmed to fail on `main` too (record them).
- [ ] `npm run smoke:clean-room` — passes.
- [ ] Manual check against your real install, from a directory outside the repo after `npm link`: `memsmith status`, `memsmith restart`, `memsmith status`, `memsmith doctor`.
- [ ] Run the `superpowers:requesting-code-review` flow (TypeScript reviewer) over the branch diff and act on its findings.

## Maintainer steps after merge (not automated)

1. `npm publish` once from a clean build at the `package.json` version, to claim `memsmith`.
2. On npmjs.com, add a trusted publisher: repository `shshalom/memsmith`, workflow `npm-publish.yml`.
3. Push the release tag: `git push origin v<version>`.
