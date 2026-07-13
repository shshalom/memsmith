# Worker Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded `local` runtime (Postgres + pgvector, in-process) the wired-in default for solo users end-to-end, then delete the legacy `worker` runtime (~18K LOC) once a mechanical safety gate proves nothing outside the worker depends on it.

**Architecture:** Four ordered phases, each an independently reviewable and revertible commit group: (1) sever non-worker→worker couplings; (2) flip + wire the `local` default across settings, runtime-selector, installer, MCP, and plugin hooks; (3) run a safety gate; (4) delete worker/SQLite/Chroma code, tests, and build wiring. Phase 4 proceeds only if Phase 3 passes. Key insight: the hook layer already talks to a server over HTTP, and `local` mode boots that same server in-process — so from a hook's perspective `local` **is** `server` pointing at a locally-booted embedded instance. The retirement collapses the `worker|server` binary into `local|server`.

**Tech Stack:** TypeScript, Bun (runtime + test runner at `~/.bun/bin/bun`), embedded Postgres 17.5 + pgvector via `@boomship/postgres-vector-embedded`, existing `createServerService` code path.

## Global Constraints

- Nothing is pushed; local clone only; no merge to `main`. Work stays on branch `embedded-pg-local-runtime`.
- Git commits end with the trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never rename keep-list dependencies (`claude-code` / `claude-agent` / `@anthropic-ai`).
- Local-dev bypass env (`MEMSMITH_LOCAL_DEV_TEAM_ID` / `MEMSMITH_LOCAL_DEV_PROJECT_ID`) is valid only on loopback + local-dev + bypass; never production/Docker. Do not touch its guards.
- Run Bun in a clean env to dodge the mise/zsh stdout-swallow: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun <cmd>`.
- The default runtime target for solo users is `local` (NOT `server`). Legacy `worker` must remap smoothly to `local`.
- Phase 4 deletion is GATED on Phase 3 passing. If any gate fails, stop at a working flipped-default state; do not delete.
- Capabilities approved to drop: `/api/logs` (Console), observation SSE broadcast, FTS-only (Chroma-disabled) mode. Do not build new server-side replacements (YAGNI).

---

## File Structure

**Phase 1 (sever) — created/modified:**
- Create `src/shared/ollama-config.ts` — neutral home for `OllamaConfig` type + `getOllamaConfig()`, no worker deps.
- Create `src/services/local-runtime-cli.ts` — the `local start|stop|status|restart` command parsing + dispatch, extracted from `worker-service.ts` so it survives worker deletion.
- Modify `src/server/runtime/import/ollamaClassifier.ts` — import `getOllamaConfig` from the shared module.
- Modify `src/services/worker/OllamaProvider.ts` — re-export or import `getOllamaConfig` from shared (keep worker compiling until Phase 4).

**Phase 2 (flip + wire) — modified:**
- `src/shared/SettingsDefaultsManager.ts:171` — default `'worker'` → `'local'`.
- `src/services/hooks/runtime-selector.ts` — add `'local'` to `SelectedRuntime`; remap `worker`→`local`; `resolveRuntimeContext` returns a server-style context for `local`.
- `src/npx-cli/commands/install.ts` — stop writing `MEMSMITH_RUNTIME='worker'`; ensure embedded runtime is started.
- `src/servers/mcp-server.ts` — treat `local` like `server` for auto-start gating.
- `plugin/hooks/hooks.json` + manifests — drop worker branches; rebuild plugin.

**Phase 3 (verify) — created:**
- Create `docs/superpowers/plans/worker-retirement-safety-gate.md` — committed pass/fail checklist artifact.

**Phase 4 (delete) — removed:** enumerated in Tasks 12–16.

---

## PHASE 1 — SEVER COUPLINGS

### Task 1: Extract `getOllamaConfig` to a shared module

**Files:**
- Create: `src/shared/ollama-config.ts`
- Modify: `src/services/worker/OllamaProvider.ts:249-261`
- Modify: `src/server/runtime/import/ollamaClassifier.ts:6`
- Test: `tests/shared/ollama-config.test.ts`

**Interfaces:**
- Produces: `export interface OllamaConfig { apiKey: string; model: string; apiUrl: string }` and `export function getOllamaConfig(): OllamaConfig` in `src/shared/ollama-config.ts`.
- Consumes: `SettingsDefaultsManager.loadFromFile` + `USER_SETTINGS_PATH` (already in `src/shared/`).

- [ ] **Step 1: Write the failing test**

Create `tests/shared/ollama-config.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { getOllamaConfig } from '../../src/shared/ollama-config.js';

describe('getOllamaConfig', () => {
  it('returns a keyless config with a chat-completions apiUrl and a default model', () => {
    const cfg = getOllamaConfig();
    expect(cfg.apiKey).toBe('ollama-local');
    expect(cfg.apiUrl.endsWith('/chat/completions')).toBe(true);
    expect(typeof cfg.model).toBe('string');
    expect(cfg.model.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/ollama-config.test.ts`
Expected: FAIL — cannot find module `../../src/shared/ollama-config.js`.

- [ ] **Step 3: Create the shared module**

Create `src/shared/ollama-config.ts` (move the logic verbatim from `OllamaProvider.ts:249-261`; find the correct relative import for `SettingsDefaultsManager`/`USER_SETTINGS_PATH` — both already live under `src/shared/`, so the import is local):

```typescript
// SPDX-License-Identifier: Apache-2.0
// Neutral home for Ollama connection config, shared by the worker provider and
// the server-side import classifier. No worker dependencies, so it survives
// worker retirement.
import { SettingsDefaultsManager, USER_SETTINGS_PATH } from './SettingsDefaultsManager.js';

export interface OllamaConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
}

export function getOllamaConfig(): OllamaConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Non-empty dummy key: the OpenAI-compat base class throws on falsy apiKey; Ollama ignores it.
  const apiKey = 'ollama-local';
  const model = (typeof settings.MEMSMITH_OLLAMA_MODEL === 'string' && settings.MEMSMITH_OLLAMA_MODEL.trim())
    ? settings.MEMSMITH_OLLAMA_MODEL : 'qwen2.5:14b';
  const base = settings.MEMSMITH_OLLAMA_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  const apiUrl = base.replace(/\/+$/, '').endsWith('/chat/completions')
    ? base
    : base.replace(/\/+$/, '') + '/chat/completions';
  return { apiKey, model, apiUrl };
}
```

NOTE: verify the exact export names/paths for `SettingsDefaultsManager` and `USER_SETTINGS_PATH` by reading the top of `src/services/worker/OllamaProvider.ts` (its existing import lines) — copy the same specifiers, adjusting the relative path to `src/shared/`.

- [ ] **Step 4: Repoint OllamaProvider at the shared module**

In `src/services/worker/OllamaProvider.ts`, delete the local `getOllamaConfig` definition (lines 249-261) and the local `OllamaConfig` type if it is defined there, and add a re-export near the top so existing worker imports keep working until Phase 4:

```typescript
export { getOllamaConfig, type OllamaConfig } from '../../shared/ollama-config.js';
```

If `OllamaConfig` is used by the class body in the same file, import it instead of re-declaring.

- [ ] **Step 5: Repoint the classifier at the shared module**

In `src/server/runtime/import/ollamaClassifier.ts:6`, change:

```typescript
import { getOllamaConfig } from '../../../services/worker/OllamaProvider.js';
```
to:
```typescript
import { getOllamaConfig } from '../../../shared/ollama-config.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/ollama-config.test.ts`
Expected: PASS.
Also run the classifier's existing tests if present: `... bun test tests/ 2>&1 | grep -i ollama` — expect no new failures.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ollama-config.ts src/services/worker/OllamaProvider.ts src/server/runtime/import/ollamaClassifier.ts tests/shared/ollama-config.test.ts
git commit -m "refactor(sever): move getOllamaConfig to src/shared (decouple server from worker)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Extract the `local` runtime CLI out of `worker-service.ts`

**Files:**
- Create: `src/services/local-runtime-cli.ts`
- Modify: `src/services/worker-service.ts` (the `rawCommand === 'local'` block at 827-833, and the `local-start`/`local-stop`/`local-status` dispatch near 1240-1260)
- Test: `tests/services/local-runtime-cli.test.ts`

**Interfaces:**
- Produces: `export function parseLocalCommand(rawCommand: string, maybeSubCommand: string | undefined, rest: string[]): { command: string; args: string[] } | null` — returns the parsed local command descriptor, or `null` when `rawCommand !== 'local'`.
- Produces: `export async function runLocalCommand(command: string, args: string[]): Promise<void>` — dispatches `local-start` (boots embedded via `startLocalRuntime`), `local-stop`, `local-status`, `local-help`.

- [ ] **Step 1: Write the failing test**

Create `tests/services/local-runtime-cli.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { parseLocalCommand } from '../../src/services/local-runtime-cli.js';

describe('parseLocalCommand', () => {
  it('returns null for a non-local command', () => {
    expect(parseLocalCommand('server', 'start', [])).toBeNull();
  });
  it('maps known subcommands to local-<sub>', () => {
    expect(parseLocalCommand('local', 'start', [])).toEqual({ command: 'local-start', args: [] });
    expect(parseLocalCommand('local', 'stop', [])).toEqual({ command: 'local-stop', args: [] });
    expect(parseLocalCommand('local', 'status', [])).toEqual({ command: 'local-status', args: [] });
    expect(parseLocalCommand('local', 'restart', [])).toEqual({ command: 'local-restart', args: [] });
  });
  it('maps an unknown subcommand to local-help', () => {
    expect(parseLocalCommand('local', 'frobnicate', [])).toEqual({ command: 'local-help', args: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/services/local-runtime-cli.test.ts`
Expected: FAIL — cannot find module `../../src/services/local-runtime-cli.js`.

- [ ] **Step 3: Create the extracted module**

Create `src/services/local-runtime-cli.ts` (the dispatch bodies are copied verbatim from `worker-service.ts:1238-1262`; `local-restart` is NOT in the current code, so it is added here as stop-then-start):

```typescript
// SPDX-License-Identifier: Apache-2.0
// The `local` runtime CLI (start|stop|status|restart), extracted from
// worker-service.ts so it survives worker retirement. Boots the embedded
// Postgres runtime via startLocalRuntime().

const LOCAL_ALIASES = new Set(['start', 'stop', 'status', 'restart']);

export function parseLocalCommand(
  rawCommand: string,
  maybeSubCommand: string | undefined,
  rest: string[],
): { command: string; args: string[] } | null {
  if (rawCommand !== 'local') return null;
  return {
    command: maybeSubCommand && LOCAL_ALIASES.has(maybeSubCommand) ? `local-${maybeSubCommand}` : 'local-help',
    args: rest,
  };
}

export async function runLocalCommand(command: string, _args: string[]): Promise<void> {
  switch (command) {
    case 'local-start': {
      process.env.MEMSMITH_RUNTIME = 'local';
      const { startLocalRuntime } = await import('../server/runtime/local-runtime.js');
      await startLocalRuntime(); // blocks in the foreground server loop
      return;
    }
    case 'local-stop': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      await new EmbeddedPostgresManager().stop();
      console.log('Local embedded Postgres stopped.');
      return;
    }
    case 'local-status': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      const running = new EmbeddedPostgresManager().isRunning();
      console.log(running ? 'Local embedded Postgres: RUNNING' : 'Local embedded Postgres: stopped');
      return;
    }
    case 'local-restart': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      await new EmbeddedPostgresManager().stop();
      process.env.MEMSMITH_RUNTIME = 'local';
      const { startLocalRuntime } = await import('../server/runtime/local-runtime.js');
      await startLocalRuntime();
      return;
    }
    case 'local-help':
    default:
      console.error('Usage: memsmith local start|stop|status|restart');
      process.exit(1);
  }
}
```

- [ ] **Step 4: Rewire worker-service.ts to delegate**

In `src/services/worker-service.ts`, replace the inline `if (rawCommand === 'local') { ... }` block (827-833) with a call to `parseLocalCommand(...)`, and replace the inline `local-start`/`local-stop`/`local-status` dispatch (~1240-1260) with `await runLocalCommand(command, args)`. Import both from `./local-runtime-cli.js`. This keeps worker-service.ts working (it is deleted in Phase 4) while the `local` logic now lives independently.

- [ ] **Step 5: Run tests + smoke the local command**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/services/local-runtime-cli.test.ts`
Expected: PASS.
Smoke: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun src/services/worker-service.ts local status`
Expected: prints local runtime status without crashing (a running or stopped report; no stack trace).

- [ ] **Step 6: Commit**

```bash
git add src/services/local-runtime-cli.ts src/services/worker-service.ts tests/services/local-runtime-cli.test.ts
git commit -m "refactor(sever): extract local runtime CLI from worker-service

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Determine SQLite reuse by the embedded/server path (Phase-4 prerequisite)

**Files:**
- Create: `docs/superpowers/plans/sqlite-reuse-audit.md` (findings artifact)

**Interfaces:**
- Produces: a committed list of every `src/storage/sqlite/` and `src/services/sqlite/` module still imported by non-worker code, with a per-module verdict: `delete` (worker-only) / `move` (embedded still uses it) / `keep-in-place`.

- [ ] **Step 1: Grep for SQLite imports from non-worker code**

Run:
```bash
cd /Users/shwaits/Workspace/team-agent-memory/MemSmith
grep -rn "storage/sqlite\|services/sqlite" src/ --include="*.ts" \
  | grep -v "src/services/worker" \
  | grep -v "src/services/sqlite" \
  | grep -v "src/storage/sqlite" \
  | grep -v ".test.ts"
```
Expected: a small list. The known hit is `sqlite-api-key-service.ts` → `src/storage/sqlite/index.ts`.

- [ ] **Step 2: For each hit, record importer, symbol, and verdict**

Write `docs/superpowers/plans/sqlite-reuse-audit.md` with a table: `importer file:line | imported symbol | used by embedded/server? | verdict`. For `sqlite-api-key-service.ts`: determine whether the embedded/`local` path (via `createServerService`/Postgres auth) actually calls it, or whether it is a worker-only auth fallback. If embedded uses it → `move` to a neutral location in a Phase-4 sub-step; if worker-only → `delete` in Phase 4.

- [ ] **Step 3: Commit the audit**

```bash
git add docs/superpowers/plans/sqlite-reuse-audit.md
git commit -m "docs(sever): audit SQLite reuse by embedded path (Phase 4 prerequisite)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## PHASE 2 — FLIP + WIRE THE DEFAULT

### Task 4: Flip the shipped default runtime to `local`

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts:171`
- Test: `tests/shared/settings-default-runtime.test.ts`

**Interfaces:**
- Consumes: the `DEFAULTS` object in `SettingsDefaultsManager.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/settings-default-runtime.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('default runtime', () => {
  it('defaults MEMSMITH_RUNTIME to local (embedded), not worker', () => {
    // Read the shipped defaults directly. Adjust accessor to match the class:
    // if defaults are exposed via a static getter, use it; otherwise load from
    // a nonexistent path so only defaults apply.
    const defaults = SettingsDefaultsManager.loadFromFile('/nonexistent/settings.json');
    expect(defaults.MEMSMITH_RUNTIME).toBe('local');
  });
});
```

NOTE: confirm `loadFromFile` on a missing path returns pure defaults (read the method). If it throws instead, use the class's defaults accessor.

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/settings-default-runtime.test.ts`
Expected: FAIL — received `'worker'`.

- [ ] **Step 3: Flip the default**

In `src/shared/SettingsDefaultsManager.ts:171`, change:
```typescript
    MEMSMITH_RUNTIME: 'worker',
```
to:
```typescript
    MEMSMITH_RUNTIME: 'local',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/settings-default-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts tests/shared/settings-default-runtime.test.ts
git commit -m "feat(flip): default MEMSMITH_RUNTIME to local (embedded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Teach the runtime selector about `local` (remap worker→local, route local like server)

**Files:**
- Modify: `src/services/hooks/runtime-selector.ts:24,39-46,100-109`
- Test: `tests/services/hooks/runtime-selector-local.test.ts`

**Interfaces:**
- Consumes: `loadFromFileOnce()` from `src/shared/hook-settings.js`; `buildServerContext()` in the same file.
- Produces: `SelectedRuntime = 'local' | 'server'` (worker removed); `selectRuntime()` returns `'local'` for unset/legacy `worker`/anything non-server; `resolveRuntimeContext()` returns a `ServerRuntimeContext` for BOTH `server` and `local` (local's server URL is its in-process embedded instance), else a new local-without-server context.

**Design note:** In `local` mode the embedded server runs in-process and `MEMSMITH_SERVER_URL` points at it (exactly the developer's current live setup). So `resolveRuntimeContext` builds a server context via `buildServerContext()` for both. If `buildServerContext()` returns null in `local` mode (URL/key/project not yet written), the hook has nothing to POST to — return a benign context that the handlers treat as "skip, embedded not yet reachable" rather than the deleted worker fallback.

- [ ] **Step 1: Write the failing test**

Create `tests/services/hooks/runtime-selector-local.test.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';

// selectRuntime reads settings via loadFromFileOnce, which caches; set env-backed
// settings before importing fresh. Use a dynamic import per case with a reset.
async function selectWith(runtime: string | undefined): Promise<string> {
  // The hook-settings loader reads ~/.memsmith/settings.json; override via the
  // documented test seam if present. If none, this test asserts the mapping
  // logic by calling the pure normalizer (extract it — see Step 3).
  const mod = await import(`../../../src/services/hooks/runtime-selector.js?ts=${runtime}`);
  return mod.normalizeRuntime(runtime);
}

describe('selectRuntime normalization', () => {
  it('maps server and server-beta to server', async () => {
    expect(await selectWith('server')).toBe('server');
    expect(await selectWith('server-beta')).toBe('server');
  });
  it('maps legacy worker to local (smooth remap)', async () => {
    expect(await selectWith('worker')).toBe('local');
  });
  it('maps unset/unknown to local', async () => {
    expect(await selectWith(undefined)).toBe('local');
    expect(await selectWith('banana')).toBe('local');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/services/hooks/runtime-selector-local.test.ts`
Expected: FAIL — `normalizeRuntime` is not exported.

- [ ] **Step 3: Extract a pure normalizer and update the types**

In `src/services/hooks/runtime-selector.ts`:

Change the type (line 24):
```typescript
export type SelectedRuntime = 'local' | 'server';
```

Add a pure, exported normalizer and use it in `selectRuntime`:
```typescript
export function normalizeRuntime(raw: string | undefined): SelectedRuntime {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'server' || v === 'server-beta') return 'server';
  // Legacy `worker` and anything unset/unknown now resolve to the embedded
  // local runtime (worker retired). Smooth remap: an existing settings.json
  // with MEMSMITH_RUNTIME=worker keeps working, pointed at embedded PG.
  return 'local';
}

export function selectRuntime(): SelectedRuntime {
  const settings = loadFromFileOnce();
  return normalizeRuntime(settings.MEMSMITH_RUNTIME);
}
```

- [ ] **Step 4: Replace WorkerRuntimeContext with a LocalRuntimeContext and update resolveRuntimeContext**

Replace the `WorkerRuntimeContext` interface (33-35) and `RuntimeContext` union (37):
```typescript
export interface LocalRuntimeContext {
  runtime: 'local';
  // Embedded server not yet reachable (URL/key/project unwritten). Handlers
  // treat this as "skip this hook cleanly" — there is no worker fallback.
  reason: 'server_context_unavailable';
}

export type RuntimeContext = ServerRuntimeContext | LocalRuntimeContext;
```

Update `resolveRuntimeContext` (100-109):
```typescript
export function resolveRuntimeContext(): RuntimeContext {
  // Both `server` and `local` reach the engine over HTTP; in `local` mode the
  // server runs in-process and MEMSMITH_SERVER_URL points at it. Build a server
  // context for either. If the context can't be built (missing URL/key/project),
  // return a local "skip" context — the worker fallback no longer exists.
  const selected = selectRuntime();
  const ctx = buildServerContext();
  if (ctx) return ctx;
  if (selected === 'server') {
    // Preserve existing server-fallback logging behavior for team mode.
    return { runtime: 'local', reason: 'server_context_unavailable' };
  }
  return { runtime: 'local', reason: 'server_context_unavailable' };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/services/hooks/runtime-selector-local.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/hooks/runtime-selector.ts tests/services/hooks/runtime-selector-local.test.ts
git commit -m "feat(flip): runtime-selector maps worker->local, routes local like server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Update hook handlers to drop the worker branch

**Files:**
- Modify: `src/cli/handlers/observation.ts:91-128` (and its tail worker-fallback block)
- Modify: `src/cli/handlers/session-init.ts:98+`
- Modify: `src/cli/handlers/summarize.ts:115+`

**Interfaces:**
- Consumes: `resolveRuntimeContext()` now returning `ServerRuntimeContext | LocalRuntimeContext` (Task 5).

- [ ] **Step 1: Read all three handlers' runtime branches**

Read the `if (runtime.runtime === 'server') { ... } else { <worker fallback> }` structure in each of `observation.ts`, `session-init.ts`, `summarize.ts`. Capture what the worker-fallback branch currently does (it calls the worker compat path).

- [ ] **Step 2: Replace the worker fallback with a clean skip in each handler**

In each handler, keep the `runtime.runtime === 'server'` success path unchanged. Replace the worker-fallback branch (and the `else`) with: if the context is `local` (server not reachable), log a debug line and `return { continue: true, suppressOutput: true }`. Remove any import of worker compat code. Example for `observation.ts` (after the server try/catch):

```typescript
    }
    // No server/local context to POST to (embedded not yet reachable). The
    // worker fallback has been retired; skip cleanly so the hook never blocks.
    logger.debug('HOOK', 'No reachable runtime for observation; skipping', { toolName });
    return { continue: true, suppressOutput: true };
```

- [ ] **Step 3: Run the handler tests**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/cli/handlers/ 2>&1 | tail -20`
Expected: PASS (update any test that asserted worker-fallback behavior to assert the clean skip instead; do NOT delete coverage, adapt it).

- [ ] **Step 4: Commit**

```bash
git add src/cli/handlers/observation.ts src/cli/handlers/session-init.ts src/cli/handlers/summarize.ts tests/cli/handlers/
git commit -m "feat(flip): hook handlers skip cleanly instead of worker fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Update the installer to stop selecting worker and to start the embedded runtime

**Files:**
- Modify: `src/npx-cli/commands/install.ts` (the `mergeSettings({ MEMSMITH_RUNTIME: 'worker' })` write, and the `ensureWorkerStarted()` call)

**Interfaces:**
- Consumes: `runLocalCommand`/`startLocalRuntime` (Task 2) for booting embedded; `SettingsDefaultsManager` for defaults.

- [ ] **Step 1: Find the worker writes**

Run:
```bash
grep -n "MEMSMITH_RUNTIME\|ensureWorkerStarted\|worker" src/npx-cli/commands/install.ts
```
Capture every line that writes `MEMSMITH_RUNTIME: 'worker'` or spawns the worker.

- [ ] **Step 2: Remove the worker runtime write**

Delete the `mergeSettings({ MEMSMITH_RUNTIME: 'worker' })` (or equivalent) so new installs inherit the `local` default from Task 4. If the installer explicitly needs a value, write `'local'`.

- [ ] **Step 3: Replace worker spawn with embedded boot**

Replace `ensureWorkerStarted(...)` with the embedded-runtime start. Since `startLocalRuntime()` blocks in the foreground, the installer should start it detached the same way the worker was spawned (mirror the existing spawn mechanism — read how `ensureWorkerStarted` detaches, and boot `worker-service local start` via the same child-process pattern). Do not block the installer.

- [ ] **Step 4: Build and smoke the installer path**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun run build 2>&1 | tail -5`
Expected: build succeeds, no dangling `ensureWorkerStarted` type errors in install.ts.

- [ ] **Step 5: Commit**

```bash
git add src/npx-cli/commands/install.ts
git commit -m "feat(flip): installer boots embedded local runtime, stops selecting worker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Update the MCP server auto-start gating for `local`

**Files:**
- Modify: `src/servers/mcp-server.ts:24,35-36,156-163,1000-1005`

**Interfaces:**
- Consumes: `selectRuntime()` now returning `'local' | 'server'` (Task 5).

- [ ] **Step 1: Read the auto-start gate**

Read `src/servers/mcp-server.ts` around 156-163 and 1000-1005. The current logic: `if (selectRuntime() === 'server')` do server-context things; otherwise lazy-spawn the worker (`ensureWorkerStarted`, imported at line 24).

- [ ] **Step 2: Treat local like server; drop the worker spawn**

Change the gate so BOTH `local` and `server` use the server context (`buildServerContext()`), and remove the `ensureWorkerStarted` import (line 24) and its call. For `local`, if no server context is available, the MCP tool should return the existing "requires a running runtime" style error rather than spawning a worker. Concretely: `if (selectRuntime() === 'server' || selectRuntime() === 'local') { <server-context path> }` and delete the else-branch worker spawn.

- [ ] **Step 3: Build to verify no dangling worker import**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun run build 2>&1 | grep -i "mcp-server\|ensureWorkerStarted" || echo "clean"`
Expected: `clean` (no unresolved worker import).

- [ ] **Step 4: Commit**

```bash
git add src/servers/mcp-server.ts
git commit -m "feat(flip): MCP server treats local like server, no worker spawn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Drop worker branches from plugin hooks and rebuild the plugin

**Files:**
- Modify: `plugin/hooks/hooks.json`; `plugin/.claude-plugin/*`; `plugin/.codex-plugin/*` (only if they carry worker-specific hook branches)
- Modify (regenerate): `plugin/scripts/*` via `scripts/build-hooks.js`

**Interfaces:**
- Consumes: the flipped source (Tasks 4-8).

- [ ] **Step 1: Inspect plugin hook routing**

Run:
```bash
grep -rn "worker\|MEMSMITH_RUNTIME" plugin/hooks/hooks.json plugin/.claude-plugin plugin/.codex-plugin 2>/dev/null
```
Capture any worker-conditional hook entries.

- [ ] **Step 2: Remove worker branches**

Edit the hook manifests to remove worker-specific dispatch; hooks call the same subcommands (which now resolve to `local`). If the manifests are generated, edit the generator source instead and regenerate.

- [ ] **Step 3: Rebuild the plugin**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun run build 2>&1 | tail -5`
Then rebuild hooks/plugin per the repo's build (e.g. `node scripts/build-hooks.js` if that is the command — verify in `package.json`).
Expected: `plugin/scripts/` regenerated; no worker-service target errors yet (WORKER_SERVICE removal happens in Phase 4 Task 15).

- [ ] **Step 4: Commit**

```bash
git add plugin/
git commit -m "feat(flip): drop worker hook branches, rebuild plugin for local default

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Flip the developer's live machine to `local`

**Files:**
- Modify: `~/.memsmith/settings.json` (runtime setting; back up first)

**Interfaces:** none (operational).

- [ ] **Step 1: Back up live settings**

Run:
```bash
cp ~/.memsmith/settings.json ~/.memsmith/settings.json.pre-local-flip.bak
grep -o '"MEMSMITH_RUNTIME"[^,]*\|"MEMSMITH_SERVER_URL"[^,]*' ~/.memsmith/settings.json
```
Expected: shows current `server` + `:37879` URL.

- [ ] **Step 2: Stop the standalone server**

Identify and stop the standalone server on :37879 (the one started in the prior session). Confirm the embedded PG on :55433 is separately managed by the `local` runtime.
Run: `lsof -nP -iTCP:37879 -sTCP:LISTEN` — stop that PID gracefully.

- [ ] **Step 3: Set runtime to local**

Edit `~/.memsmith/settings.json`: set `MEMSMITH_RUNTIME` to `local`. Leave `MEMSMITH_SERVER_URL` as-is (local runtime will boot its in-process server and the hook context uses it).

- [ ] **Step 4: Boot local and verify capture end-to-end**

Start: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun src/services/worker-service.ts local start` (detached/background).
Verify: fire a test event through the hook path and confirm an observation lands in embedded PG (query :55433 `observations` count before/after).
Expected: count increases; newest observation is the test event.

- [ ] **Step 5: Commit (settings are outside the repo — record the change in the ledger)**

No repo commit (settings.json is in `~/.memsmith`, not the repo). Note the flip + backup path in the progress ledger.

---

## PHASE 3 — VERIFY SAFE-TO-DELETE (GATE)

### Task 11: Run the safety gate and commit the checklist artifact

**Files:**
- Create: `docs/superpowers/plans/worker-retirement-safety-gate.md`

**Interfaces:**
- Consumes: Tasks 1-10 complete; Task 3's SQLite audit.

- [ ] **Step 1: Gate 1 — no live imports of worker code**

Run:
```bash
cd /Users/shwaits/Workspace/team-agent-memory/MemSmith
grep -rn "services/worker/\|worker-service\|worker-spawner\|worker-shutdown\|storage/sqlite\|services/sqlite\|ChromaSync\|ChromaMcpManager\|ChromaSyncState" src/ --include="*.ts" \
  | grep -v "src/services/worker" \
  | grep -v "src/storage/sqlite" \
  | grep -v "src/services/sqlite" \
  | grep -v ".test.ts"
```
Expected: ZERO hits, EXCEPT any `move`-verdict module from Task 3's audit (which is handled in Phase 4). Record the output verbatim in the artifact. Any unexpected hit = a missed coupling; STOP and fix (return to Phase 1) before proceeding.

- [ ] **Step 2: Gate 2 — full suite green with worker excluded**

Run:
```bash
env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin MEMSMITH_RUNTIME=local \
  ~/.bun/bin/bun test tests/ 2>&1 | tail -25
```
Exclude the worker-specific test files via a path filter (do NOT delete them — they are deleted in Phase 4). Record pass/fail counts. Expected: everything non-worker green.

- [ ] **Step 3: Gate 3 — clean-install E2E on embedded only**

From a scratch temp home:
```bash
TMPHOME=$(mktemp -d)
env -i HOME="$TMPHOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun <installer entry> 2>&1 | tail
```
Confirm: installer lands on `local`; embedded boots; a fired capture event lands an observation in embedded PG; a retrieval query returns it. Record each step's result. Expected: all pass.

- [ ] **Step 4: Gate 4 — capability-loss ledger dispositions confirmed**

Confirm no live consumer for the three dropped capabilities:
```bash
grep -rn "/api/logs" src/ --include="*.ts" | grep -v "src/services/worker"
grep -rn "ObservationBroadcaster\|SessionEventBroadcaster\|SSE\|EventSource" src/ --include="*.ts" | grep -v "src/services/worker"
grep -rn "CHROMA_ENABLED\|chromaEnabled\|FTS.only\|ftsOnly" src/ --include="*.ts" | grep -v "src/services/worker"
```
Expected: no non-worker consumer. Record verdicts (all `drop`). Any live consumer = re-scope before deleting.

- [ ] **Step 5: Write and commit the gate artifact**

Write `docs/superpowers/plans/worker-retirement-safety-gate.md` capturing all four gate results (verbatim command output + PASS/FAIL). Only if ALL PASS, mark the document "GATE PASSED — Phase 4 unblocked".

```bash
git add docs/superpowers/plans/worker-retirement-safety-gate.md
git commit -m "docs(verify): worker-retirement safety gate results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

**STOP CONDITION:** If any gate failed, do not proceed to Phase 4. Fix the failure (return to the relevant earlier phase) and re-run the gate.

---

## PHASE 4 — DELETE (gated on Task 11 = GATE PASSED)

Delete in dependency order. After EACH task, re-run Gate 1 (grep) + the suite; a dangling import surfaces at the task that caused it.

### Task 12: Delete worker HTTP + core runtime code

**Files:**
- Remove: `src/services/worker/` (entire directory)
- Remove: `src/services/worker-spawner.ts`, `src/services/worker-shutdown.ts`

- [ ] **Step 1: Confirm no live importers remain (post Tasks 1-11)**

Run the Gate 1 grep from Task 11 Step 1. Expected: ZERO (worker-owned + `move`-verdict modules aside).

- [ ] **Step 2: Delete the directories/files**

```bash
git rm -r src/services/worker src/services/worker-spawner.ts src/services/worker-shutdown.ts
```

- [ ] **Step 3: Build + Gate 1 + suite**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun run build 2>&1 | tail -10`
Expected: build succeeds (any error names the dangling import to fix). Re-run Gate 1 grep → zero. Re-run suite (worker tests still present here — exclude via filter) → non-worker green.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(delete): remove worker runtime + spawner + shutdown

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Delete `worker-service.ts` (local CLI already extracted in Task 2)

**Files:**
- Remove: `src/services/worker-service.ts`
- Verify: any remaining importer now uses `src/services/local-runtime-cli.ts`

- [ ] **Step 1: Find importers of worker-service**

Run: `grep -rn "worker-service" src/ --include="*.ts" | grep -v ".test.ts"`
Expected: only build config references (handled in Task 15). Any code importer must be repointed to `local-runtime-cli.ts` first.

- [ ] **Step 2: Delete the file**

```bash
git rm src/services/worker-service.ts
```

- [ ] **Step 3: Build + suite**

Run build + suite as in Task 12 Step 3. Expected: succeeds; the `local` CLI still works via `local-runtime-cli.ts` (smoke: `... bun src/services/local-runtime-cli.ts` is not an entrypoint — instead confirm the plugin/CLI entry that now drives local still resolves; if worker-service was the CLI entry, ensure a `local` entry exists or is added here).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(delete): remove worker-service.ts (local CLI extracted earlier)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 14: Delete SQLite stores and Chroma sync (per Task 3 audit)

**Files:**
- Remove: `src/storage/sqlite/` and `src/services/sqlite/` — EXCEPT any `move`-verdict module from Task 3 (move it to a neutral location in this task instead of deleting).
- Remove: Chroma files in `src/services/sync/` (`ChromaSync.ts`, `ChromaMcpManager.ts`, `ChromaSyncState.ts`).

- [ ] **Step 1: Apply any `move` verdicts first**

For each module Task 3 flagged `move` (e.g. if `sqlite-api-key-service` truly needs a SQLite helper), relocate it to a neutral path and repoint importers. Commit that move separately.

- [ ] **Step 2: Delete the worker-only SQLite + Chroma code**

```bash
git rm -r src/services/sync/ChromaSync.ts src/services/sync/ChromaMcpManager.ts src/services/sync/ChromaSyncState.ts
git rm -r src/storage/sqlite src/services/sqlite   # minus any moved module
```

- [ ] **Step 3: Build + Gate 1 + suite**

As Task 12 Step 3. Expected: succeeds; Gate 1 zero.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(delete): remove SQLite stores + Chroma sync (pgvector replaces Chroma)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 15: Remove worker build targets and plugin scripts

**Files:**
- Modify: `scripts/build-hooks.js:10-13` (remove `WORKER_SERVICE` target)
- Modify: `package.json` (remove `build:binaries`, `build:cli-binary`; remove `worker:restart` from `build-and-sync`)
- Remove: `plugin/scripts/worker-service.cjs`, `plugin/scripts/worker-cli.js`, `plugin/scripts/worker-wrapper.cjs`

- [ ] **Step 1: Remove the WORKER_SERVICE build target**

In `scripts/build-hooks.js`, delete the `WORKER_SERVICE = {...}` definition (around 10-13) and any reference to it in the build list. Keep `SERVER_SERVICE`, `MCP_SERVER`, `CONTEXT_GENERATOR`, `TRANSCRIPT_WATCHER`.

- [ ] **Step 2: Clean package.json scripts**

Read `package.json` scripts. Remove `build:binaries` and `build:cli-binary`. In `build-and-sync`, remove the `worker:restart` invocation (replace with `local` restart if the workflow needs a restart, else drop).

- [ ] **Step 3: Remove generated worker plugin scripts**

```bash
git rm plugin/scripts/worker-service.cjs plugin/scripts/worker-cli.js plugin/scripts/worker-wrapper.cjs
```

- [ ] **Step 4: Rebuild the plugin, confirm clean**

Run the build + plugin build. Expected: no WORKER_SERVICE reference, plugin regenerates without worker scripts.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-hooks.js package.json plugin/
git commit -m "chore(delete): remove worker build targets + plugin scripts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 16: Delete worker tests and do the final green-suite pass

**Files:**
- Remove: `tests/worker-*.test.ts`, `tests/services/worker-*.test.ts`, `tests/integration/worker-api-endpoints.test.ts`, `tests/infrastructure/worker-json-status.test.ts`, worker util tests under `tests/shared/`

- [ ] **Step 1: Enumerate worker tests**

Run: `grep -rln "services/worker\|worker-service\|worker-spawner\|ChromaSync\|storage/sqlite" tests/ --include="*.test.ts"`
Capture the list.

- [ ] **Step 2: Delete them**

`git rm` each file from the enumerated list. Keep any test that only touches surviving (moved) modules.

- [ ] **Step 3: Final full suite (no exclusion filter now)**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin MEMSMITH_RUNTIME=local ~/.bun/bin/bun test tests/ 2>&1 | tail -25`
Expected: fully green with NO worker exclusion filter — the worker tests are gone and nothing references worker code.

- [ ] **Step 4: Final Gate 1 grep**

Run the Task 11 Step 1 grep. Expected: ZERO hits, no exceptions.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "chore(delete): remove worker tests; suite green on local-only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-plan verification (whole branch)

- [ ] `git log --oneline` shows the four phases as distinct commit groups.
- [ ] Full suite green under `MEMSMITH_RUNTIME=local`.
- [ ] Gate 1 grep returns zero.
- [ ] Developer machine runs on `local`, capture + retrieve verified.
- [ ] Nothing pushed; branch not merged.
