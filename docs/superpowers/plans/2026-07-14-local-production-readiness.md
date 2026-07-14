# Local Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `local` installable and usable hands-off (cold boot auto-scopes to the project's real identity; viewer shows its data) with a trustworthy test suite as the gate. No push/release.

**Architecture:** (A) a per-file isolated test runner as the trustworthy gate + fix the known leaker + fix the 2 genuine test failures; (B) a single local-scope resolver (`env > marker > mint`) that replaces the scattered `MEMSMITH_LOCAL_DEV_* || 'local'` reads in the import path AND the server-boot path, so runtime boot, auth scope, and viewer scope all agree with the migrated data's durable identity.

**Tech Stack:** TypeScript, Bun (test), embedded Postgres, React viewer, Node scripts.

**Spec:** `docs/superpowers/specs/2026-07-14-local-production-readiness-design.md`

## Global Constraints

- **Scope resolution precedence (B):** `env (MEMSMITH_LOCAL_DEV_TEAM_ID/PROJECT_ID, if set) > project marker (.memsmith/project.json) > mint via ensureProjectIdentity`. Applied at BOTH `local-runtime.ts` (import) and `create-server-service.ts` (server/viewer). Reuse `src/services/identity/project-identity.ts` — do not duplicate marker-reading.
- **Do NOT touch** `src/cli/handlers/context.ts` (the SessionStart injection reader) or the `/v1` auth gate beyond consuming the resolver's output.
- **A3 is a TEST fix, not a code fix** (evidence-based decision): claude-mem migrated rows have content but no `metadata.title`; `adaptObservation`'s `deriveTitle` correctly turns content into a readable title (3176 rows would otherwise show "Untitled"). The stale test asserts `title===null`; update the TEST to the derived-title contract. Do NOT make adaptObservation return null.
- **A4 is one site:** `src/server/dashboard/spend.ts:75` — wrap `process.env` in `sanitizeEnv` (from `src/supervisor/env-sanitizer.ts`, `sanitizeEnv(env=process.env)`), preserving `...extraEnv`.
- **Per-file gate must be green (0 real fails)** after A3+A4. `bun test` stays as the fast/noisy dev shortcut.
- Never rename keep-list deps. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `local-production-readiness`. Do not push. Do NOT `git checkout <hash>` (detaches HEAD).
- Bun clean-env: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun ...`.
- **Embedded-PG gotchas (for any live verification):** the manager's pidfile is `~/.memsmith/local-pg.pid` (NOT postgres's `postmaster.pid`); a stale one makes `isRunning()` falsely report reuse — clear it if boot says `reused:true` but nothing listens on 55433. Conn: `postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres`; embedded psql needs `DYLD_LIBRARY_PATH=~/.memsmith/pg-binaries/lib`.

---

### Task 1: Per-file isolated test runner (the trustworthy gate)

**Files:**
- Create: `scripts/test-isolated.cjs`
- Modify: `package.json` (add `"test:ci"` script)
- Test: `tests/infra/test-isolated-runner.test.ts` (create — a self-check)

**Interfaces:**
- Produces: `node scripts/test-isolated.cjs` runs each `tests/**/*.test.ts(x)` in its own `bun test <file>` process, aggregates, exits non-zero if any file fails; prints a summary + failing-file list. Accepts an optional dir arg (default `tests`).

- [ ] **Step 1: Write the failing self-check test**

Create `tests/infra/test-isolated-runner.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RUNNER = join(import.meta.dir, '..', '..', 'scripts', 'test-isolated.cjs');

function runOn(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [RUNNER, dir], { encoding: 'utf-8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('test-isolated runner', () => {
  it('exits 0 when all files pass and non-zero when a file fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.test.ts'), `import {test,expect} from 'bun:test'; test('ok',()=>expect(1).toBe(1));`);
    const pass = runOn(dir);
    expect(pass.code).toBe(0);

    writeFileSync(join(dir, 'bad.test.ts'), `import {test,expect} from 'bun:test'; test('bad',()=>expect(1).toBe(2));`);
    const fail = runOn(dir);
    expect(fail.code).not.toBe(0);
    expect(fail.out).toContain('bad.test.ts');
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/infra/test-isolated-runner.test.ts`
Expected: FAIL — runner script not found.

- [ ] **Step 3: Implement the runner**

Create `scripts/test-isolated.cjs`:

```javascript
#!/usr/bin/env node
// Runs each test file in its OWN `bun test` process so cross-file global-state
// pollution (mock.module is process-global; singletons persist) cannot cause
// phantom failures. This is the trustworthy CI gate; `bun test` (single-process)
// remains the fast-but-noisy dev shortcut.
const { readdirSync, statSync } = require('fs');
const { join, relative } = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const dir = process.argv[2] ? join(root, process.argv[2]) : join(root, 'tests');
const BUN = process.env.BUN_BIN || (process.env.HOME + '/.bun/bin/bun');

function walk(d, acc) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

const files = walk(dir, []).sort();
const failed = [];
let ran = 0;
for (const f of files) {
  ran++;
  const r = spawnSync(BUN, ['test', f], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf-8' });
  if (r.status !== 0) {
    failed.push(relative(root, f));
    process.stderr.write(`FAIL ${relative(root, f)}\n${r.stderr || ''}\n`);
  }
}
console.log(`\ntest-isolated: ran ${ran} files, ${failed.length} failed`);
if (failed.length) { failed.forEach(f => console.log('  FAIL ' + f)); process.exit(1); }
process.exit(0);
```

- [ ] **Step 4: Add the npm script**

In `package.json` scripts, add: `"test:ci": "node scripts/test-isolated.cjs"`. Leave `"test": "bun test"` as-is.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/infra/test-isolated-runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-isolated.cjs package.json tests/infra/test-isolated-runner.test.ts
git commit -m "$(printf 'test(infra): per-file isolated test runner (trustworthy gate vs single-process pollution)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Fix the 2 genuine failures (adaptObservation test + spawn-env)

**Files:**
- Modify: `tests/viewer/server-adapter.test.ts` (A3 — fix the stale test)
- Modify: `src/server/dashboard/spend.ts:75` (A4 — sanitizeEnv)
- Test: existing (`server-adapter.test.ts`, `env-isolation.test.ts`)

**Interfaces:**
- Consumes: `sanitizeEnv` from `src/supervisor/env-sanitizer.ts` (`sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv`).

- [ ] **Step 1: Fix the stale adaptObservation test (A3)**

In `tests/viewer/server-adapter.test.ts`, the test "missing metadata degrades to empty, never throws" wrongly asserts `title === null || ''`. The code intentionally derives a readable title from `content` (verified: migrated rows have content but no `metadata.title`; deriving beats "Untitled"). Update the assertion to the real contract — never-throws, content preserved, and title is the derived first-line (non-empty when content is non-empty):

```typescript
  test('missing metadata degrades gracefully (derives title from content), never throws', () => {
    const bare = { id: 'x', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: 'body line one\nrest', metadata: {}, createdAtEpoch: 1, updatedAtEpoch: 1 };
    expect(() => adaptObservation(bare as any)).not.toThrow();
    const o = adaptObservation(bare as any);
    expect(o.text).toBe('body line one\nrest');            // content preserved
    expect(o.title).toBe('body line one');                  // title derived from first line
  });

  test('empty content with no metadata yields a null/empty title', () => {
    const empty = { id: 'y', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: '', metadata: {}, createdAtEpoch: 1, updatedAtEpoch: 1 };
    const o = adaptObservation(empty as any);
    expect(o.title === null || o.title === '').toBeTruthy(); // no content -> no derived title
  });
```

(Confirm the derived title matches `deriveTitle`'s actual output — first line, first sentence, ≤100 chars. Adjust the expected string to the real function if the split differs. The binding intent: non-empty content → non-null derived title; empty content → null/empty.)

- [ ] **Step 2: Run to verify the adaptObservation test passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/viewer/server-adapter.test.ts`
Expected: PASS (all cases).

- [ ] **Step 3: Fix the spawn-env violation (A4)**

`src/server/dashboard/spend.ts:75` currently:
```typescript
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
```
Change to (add the import if absent):
```typescript
// top of file:
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
// line 75:
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...sanitizeEnv(process.env), ...extraEnv } });
```
`sanitizeEnv` preserves PATH/HOME (which `ccusage` needs) while stripping blocked/leaky vars.

- [ ] **Step 4: Run to verify the spawn-env guard passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/env-isolation.test.ts`
Expected: PASS — "spawn-env discipline (CI guard)" reports 0 violations.

- [ ] **Step 5: tsc**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add tests/viewer/server-adapter.test.ts src/server/dashboard/spend.ts
git commit -m "$(printf 'fix(local-prod): sanitizeEnv on ccusage spawn + correct stale adaptObservation title test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Fix the known test-pollution leaker(s) (bounded)

**Files:**
- Modify: whichever test file(s) leak process-global state (bisect to find). Likely candidate: a `mock.module(...)` not restored in `afterAll`, or a mutated singleton.

**Interfaces:**
- Produces: single-process `bun test` fail-count materially reduced (ideally to the same ~2 the isolated run finds, now fixed to 0).

- [ ] **Step 1: Establish the current single-process baseline**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin MEMSMITH_RUNTIME=local ~/.bun/bin/bun test 2>&1 | tail -3`
Record the fail count (was ~27 pre-A2/A3/A4; should now be lower after Task 2). Note which suites still fail only in-suite (they pass under `test:ci`).

- [ ] **Step 2: Bisect to the leaker**

For each suite that fails in-suite but passes alone, find what precedes it. The known pattern (this session): `tests/hooks/runtime-selector.test.ts` does `mock.module('../../src/shared/hook-settings.js', ...)` and `mock.module('.../logger.js', ...)`. Bun's `mock.module` is process-global and survives `mock.restore()`. Check whether its `afterAll` re-registers the REAL modules (snapshot restore). Grep candidates:
```bash
grep -rln "mock.module" tests/ --include="*.ts" | xargs grep -L "afterAll" 
```
Any file that calls `mock.module` without an `afterAll` restore is a prime leaker.

- [ ] **Step 3: Fix the leaker(s)**

For each identified leaker, add an `afterAll` that restores the real module (snapshot the real module before mocking, re-register it after) — mirror the pattern already in `tests/hooks/runtime-selector.test.ts:34-36` if it has one, or add it. Fix only the clearly-identified leakers.

- [ ] **Step 4: Re-measure single-process**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin MEMSMITH_RUNTIME=local ~/.bun/bin/bun test 2>&1 | tail -3`
Expected: fail count materially lower than Step 1. Document any residual known leaker (acceptable — the `test:ci` gate is the guarantee).

- [ ] **Step 5: Confirm the isolated gate is fully green**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin BUN_BIN="$HOME/.bun/bin/bun" node scripts/test-isolated.cjs 2>&1 | tail -5`
Expected: `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "$(printf 'test(infra): restore process-global mocks in afterAll to reduce single-process pollution\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Single local-scope resolver (`env > marker > mint`)

**Files:**
- Create: `src/server/runtime/resolve-local-scope.ts`
- Test: `tests/server/resolve-local-scope.test.ts` (create)

**Interfaces:**
- Consumes: `ensureProjectIdentity` from `src/services/identity/project-identity.js`; the marker at `.memsmith/project.json`.
- Produces: `resolveLocalScope(opts: { cwd: string; pool?: QueryablePool }): Promise<{ teamId: string; projectId: string }>` — precedence env > marker > mint. Also a sync `readLocalScopeFromMarkerOrEnv(cwd): { teamId, projectId } | null` for callers without a pool.

- [ ] **Step 1: Write the failing test**

Create `tests/server/resolve-local-scope.test.ts`:

```typescript
import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveLocalScope } from '../../src/server/runtime/resolve-local-scope.js';

function fakePool() {
  const calls: any[] = [];
  return { calls, query: async (t: string, v?: unknown[]) => { calls.push({ t, v }); return { rows: [], rowCount: 0 }; } } as any;
}

describe('resolveLocalScope (env > marker > mint)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'scope-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); delete process.env.MEMSMITH_LOCAL_DEV_TEAM_ID; delete process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID; });

  it('env wins when set', async () => {
    process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = 'envteam';
    process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = 'envproj';
    const s = await resolveLocalScope({ cwd, pool: fakePool() });
    expect(s).toEqual({ teamId: 'envteam', projectId: 'envproj' });
  });

  it('marker wins when env unset and marker present', async () => {
    mkdirSync(join(cwd, '.memsmith'), { recursive: true });
    writeFileSync(join(cwd, '.memsmith', 'project.json'), JSON.stringify({ teamId: 'mteam', projectId: 'mproj', note: 'x' }));
    const s = await resolveLocalScope({ cwd, pool: fakePool() });
    expect(s).toEqual({ teamId: 'mteam', projectId: 'mproj' });
  });

  it('mints (writes marker + upserts rows) when neither env nor marker', async () => {
    const pool = fakePool();
    const s = await resolveLocalScope({ cwd, pool });
    expect(s.teamId).toMatch(/[0-9a-f-]{36}/);
    expect(s.projectId).toMatch(/[0-9a-f-]{36}/);
    // marker now exists (minted)
    const { existsSync } = await import('fs');
    expect(existsSync(join(cwd, '.memsmith', 'project.json'))).toBe(true);
    // teams/projects upserted
    expect(pool.calls.some((c: any) => /insert into teams/i.test(c.t))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/server/resolve-local-scope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/server/runtime/resolve-local-scope.ts`:

```typescript
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

interface QueryablePool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>; }

function envScope(): { teamId: string; projectId: string } | null {
  const t = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim();
  const p = (process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID ?? '').trim();
  return t && p ? { teamId: t, projectId: p } : null;
}

function markerScope(cwd: string): { teamId: string; projectId: string } | null {
  const path = join(cwd, '.memsmith', 'project.json');
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8')) as { teamId?: string; projectId?: string };
    return m.teamId && m.projectId ? { teamId: m.teamId, projectId: m.projectId } : null;
  } catch { return null; }
}

// Sync best-effort for callers without a pool: env > marker (no minting).
export function readLocalScopeFromMarkerOrEnv(cwd: string): { teamId: string; projectId: string } | null {
  return envScope() ?? markerScope(cwd);
}

// Full resolution: env > marker > mint. Minting requires a pool.
export async function resolveLocalScope(
  opts: { cwd: string; pool?: QueryablePool },
): Promise<{ teamId: string; projectId: string }> {
  const fromEnvOrMarker = readLocalScopeFromMarkerOrEnv(opts.cwd);
  if (fromEnvOrMarker) return fromEnvOrMarker;

  if (opts.pool) {
    const { ensureProjectIdentity } = await import('../../services/identity/project-identity.js');
    return ensureProjectIdentity(opts.pool as any, opts.cwd);
  }

  // Last resort (no pool, no env, no marker): preserve legacy 'local' behavior.
  logger.warn('SYSTEM', 'resolveLocalScope: no env/marker and no pool to mint; falling back to local/local');
  return { teamId: 'local', projectId: 'local' };
}
```

Confirm the `logger` import path matches the project (`../../utils/logger.js` — same as project-identity.ts uses).

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/server/resolve-local-scope.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/resolve-local-scope.ts tests/server/resolve-local-scope.test.ts
git commit -m "$(printf 'feat(local-prod): resolveLocalScope helper (env > marker > mint)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Wire the resolver into runtime boot + server/viewer scope

**Files:**
- Modify: `src/server/runtime/local-runtime.ts` (`defaultRunImport`, ~:51-52)
- Modify: `src/server/runtime/create-server-service.ts` (~:207-222, the `localDevTeamId`/`localDevProjectId` reads)
- Test: `tests/server/local-runtime-import.test.ts` (extend if it exists) or a focused new test

**Interfaces:**
- Consumes: `resolveLocalScope` / `readLocalScopeFromMarkerOrEnv` (Task 4).
- Produces: both the import scope and the server/viewer scope derive from the marker identity when env is unset.

- [ ] **Step 1: Repoint local-runtime.ts import scope**

In `src/server/runtime/local-runtime.ts` `defaultRunImport`, replace:
```typescript
  const teamId = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim() || 'local';
  const projectId = (process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID ?? '').trim() || 'local';
```
with (the pool is created a few lines below — move the resolver call to AFTER `const pool = getSharedPostgresPool(...)`, or use the pool it already has):
```typescript
  const { resolveLocalScope } = await import('./resolve-local-scope.js');
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  // (after pool is available)
  const { teamId, projectId } = await resolveLocalScope({ cwd, pool });
```
Ensure `resolveLocalScope` is called after `pool` exists so it can mint if needed. The existing teams/projects upserts remain (idempotent; ensureProjectIdentity also upserts — harmless).

- [ ] **Step 2: Repoint create-server-service.ts server/viewer scope**

In `src/server/runtime/create-server-service.ts` (~:207-210):
```typescript
  const localDevTeamId = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim() || null;
  const localDevProjectId = (process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID ?? '').trim() || null;
```
Replace with a marker-aware read (env > marker; no minting here — the runtime boot in Step 1 already minted, so the marker exists by now):
```typescript
  const { readLocalScopeFromMarkerOrEnv } = await import('./resolve-local-scope.js');
  const _scope = readLocalScopeFromMarkerOrEnv(process.env.MEMSMITH_PROJECT_CWD ?? process.cwd());
  const localDevTeamId = _scope?.teamId ?? null;
  const localDevProjectId = _scope?.projectId ?? null;
```
This makes the viewer/auth scope follow the same marker identity as the data. (If `create-server-service.ts` is not `async` at that point, read the marker synchronously — `readLocalScopeFromMarkerOrEnv` is sync; use a sync `require`/top import instead of dynamic `import` if needed.)

- [ ] **Step 3: Write/extend a test proving the wiring**

Add a focused test asserting that with a marker present and env unset, `create-server-service`'s resolved `localDevTeamId` equals the marker's teamId (mock/stub the marker file at a temp cwd via `MEMSMITH_PROJECT_CWD`). If `local-runtime-import.test.ts` already exercises `defaultRunImport`, extend it to assert the scope comes from the marker, not `'local'`. Keep it hermetic (fake pool + temp cwd).

- [ ] **Step 4: Run tests + tsc**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/server/resolve-local-scope.test.ts tests/server/local-runtime-import.test.ts 2>&1 | tail -4`
Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"` → empty.
Expected: pass; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/local-runtime.ts src/server/runtime/create-server-service.ts tests/server/
git commit -m "$(printf 'feat(local-prod): runtime boot + viewer scope resolve from project marker (not env-default local)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Build, cold-boot walkthrough, full verification (the acceptance proof)

**Files:** none new — integration verification + build. (Controller runs this live, not a subagent — it touches the live runtime.)

- [ ] **Step 1: tsc + build-and-sync**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit` → clean.
Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:$HOME/.bun/bin npm run build-and-sync` → "Sync complete!"; `.mcp.json` present in marketplace; no worker-service.cjs resurrection.

- [ ] **Step 2: The isolated gate is green**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin BUN_BIN="$HOME/.bun/bin/bun" node scripts/test-isolated.cjs 2>&1 | tail -5`
Expected: `0 failed`.

- [ ] **Step 3: Cold-boot walkthrough (B3 acceptance)**

Stop all hand-run instances; clear the manager pidfile if stale (`~/.memsmith/local-pg.pid`); **unset** `MEMSMITH_LOCAL_DEV_TEAM_ID`/`PROJECT_ID`. Boot the runtime the way the plugin does (the `local` runtime start, WITHOUT passing the dogfood env). Then verify — with zero manual scope env:
- server comes up on the 388xx port;
- `/api/observations` (viewer) returns the dogfood project's rows (not empty);
- `/v1/search` returns the project's memory.
Document the exact commands + observed output. This proves auto-scope-from-marker works end-to-end.

- [ ] **Step 4: Record + finish**

Record the walkthrough result in the ledger. Then hand to `superpowers:finishing-a-development-branch`.

---

## Notes for the executor

- Tasks 1–5 are subagent-implementable (isolated, testable). **Task 6 the controller runs live** (touches the running runtime; don't delegate the live boot).
- The load-bearing correctness rule: after Task 5, cold boot with NO `MEMSMITH_LOCAL_DEV_*` env must scope to the marker identity (where the data is). If it still shows 'local'/empty, the wiring missed a path — check BOTH local-runtime.ts AND create-server-service.ts consume the resolver.
- A3 is a test fix (evidence: migrated rows derive good titles); do not make adaptObservation return null.
- Don't push, don't bump version.
