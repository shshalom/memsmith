# Per-Project Runtime Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make runtime mode (`local`/`server`) resolvable per-project via the `.memsmith/project.json` marker, so one machine can run project B in team mode while project A stays local. Sub-spec 1 of the project-scoped Go Team fix.

**Architecture:** Extend the per-project marker with optional `runtime`/`serverUrl`; make `selectRuntime` marker-aware (marker wins, global default); add `writeProjectRuntime` for the flip; keep the team API key in `CredentialStore` (never the marker). Back-compat: any marker without a `runtime` field resolves exactly as today.

**Tech Stack:** TypeScript, `bun test`, existing marker (`project-identity.ts`), `runtime-selector.ts`, `CredentialStore`.

## Global Constraints

- **Never commit to `main`;** branch `per-project-runtime` (created; spec @ `f7ed39ce`). Rollback point: `main` @ `b2b57673`. `--no-ff` merge w/ rollback SHA. Nothing pushed.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Secret never in the marker.** Team API key lives only in `CredentialStore` (`~/.memsmith/credentials.json`, keyed by `teamId`). Marker holds `teamId`+`serverUrl` (non-secret refs) only.
- **Back-compat mandatory.** A marker WITHOUT a `runtime` field MUST resolve exactly as today (fall through to global `MEMSMITH_RUNTIME`, default `local`). The dogfood (local, no runtime marker) must stay `local`. Legacy global `MEMSMITH_RUNTIME=server` + no marker runtime must stay `server`.
- **Two marker readers exist** — `project-identity.ts` has private `readMarker`/`writeMarker`; `runtime-selector.ts` has its OWN private `readMarkerFor`. Both must understand the new fields consistently (the plan extends both; see Task 2 note).
- **Test runner:** `bun test <path>`. Known-benign TS editor diagnostics (`bun:test`, `.js` imports) are false-positives. 5 pre-existing `tests/server/` failures are environmental (`ECONNREFUSED :55432`) — not this branch's concern.

---

### Task 1: Extend the marker shape + `writeProjectRuntime` (project-identity.ts)

**Files:**
- Modify: `src/services/identity/project-identity.ts`
- Test: `tests/services/identity/project-runtime-marker.test.ts`

**Interfaces:**
- Produces:
  - Extended `ProjectMarker`: adds optional `runtime?: 'local' | 'server'`, `serverUrl?: string`.
  - `export function writeProjectRuntime(cwd: string, runtime: { runtime: 'local' | 'server'; serverUrl?: string }): void` — merges runtime fields into the existing marker, preserving `projectId`/`teamId`/`note`, never writing a key.
  - `readMarker` extended to preserve/return `runtime`/`serverUrl` when present.

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/identity/project-runtime-marker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeProjectRuntime, readProjectMarker } from '../../../src/services/identity/project-identity.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-marker-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedMarker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('project runtime marker', () => {
  it('writeProjectRuntime merges runtime fields, preserving identity + note', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'keep me' });
    writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://team.example:38890' });
    const m = readProjectMarker(dir)!;
    expect(m.teamId).toBe('t1');
    expect(m.projectId).toBe('p1');
    expect(m.note).toBe('keep me');
    expect(m.runtime).toBe('server');
    expect(m.serverUrl).toBe('http://team.example:38890');
  });
  it('never writes a key/secret field into the marker', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'n' });
    writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://x:1' });
    const raw = readFileSync(join(dir, '.memsmith', 'project.json'), 'utf-8').toLowerCase();
    expect(raw.includes('key')).toBe(false);
    expect(raw.includes('secret')).toBe(false);
    expect(raw.includes('cmem_')).toBe(false);
  });
  it('readProjectMarker returns runtime/serverUrl when present, undefined when absent', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'n', runtime: 'server', serverUrl: 'http://x:1' });
    const m = readProjectMarker(dir)!;
    expect(m.runtime).toBe('server');
    seedMarker({ teamId: 't2', projectId: 'p2', note: 'n' });
    const m2 = readProjectMarker(dir)!;
    expect(m2.runtime).toBeUndefined();
    expect(m2.serverUrl).toBeUndefined();
  });
  it('writeProjectRuntime on a missing marker is a no-op-safe error (does not create a partial identity-less marker)', () => {
    // No marker seeded.
    expect(() => writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://x:1' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS**

Run: `bun test tests/services/identity/project-runtime-marker.test.ts`
Expected: FAIL — `writeProjectRuntime`/`readProjectMarker` not exported.

- [ ] **Step 3: Implement in `project-identity.ts`**

Extend the interface + reader, add the two exports:
```ts
interface ProjectMarker {
  projectId: string;
  teamId: string;
  note: string;
  runtime?: 'local' | 'server';
  serverUrl?: string;
}
```
Update `readMarker` to preserve the new fields:
```ts
function readMarker(cwd: string): ProjectMarker | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectMarker>;
    if (m.teamId && m.projectId) {
      const out: ProjectMarker = { teamId: m.teamId, projectId: m.projectId, note: m.note ?? MARKER_NOTE };
      if (m.runtime === 'local' || m.runtime === 'server') out.runtime = m.runtime;
      if (typeof m.serverUrl === 'string' && m.serverUrl.length > 0) out.serverUrl = m.serverUrl;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// Public reader (the internal readMarker stays private; expose a stable read for other modules).
export function readProjectMarker(cwd: string): ProjectMarker | null {
  return readMarker(cwd);
}

// Merge runtime fields into an EXISTING marker. Requires the identity marker to
// already exist (throws otherwise — never writes an identity-less partial).
// NEVER writes a key/secret: the team credential lives in CredentialStore.
export function writeProjectRuntime(
  cwd: string,
  runtime: { runtime: 'local' | 'server'; serverUrl?: string },
): void {
  const existing = readMarker(cwd);
  if (!existing) {
    throw new Error(`writeProjectRuntime: no project marker at ${join(cwd, MARKER_RELATIVE_PATH)} — mint identity first`);
  }
  const merged: ProjectMarker = {
    ...existing,
    runtime: runtime.runtime,
    ...(runtime.serverUrl ? { serverUrl: runtime.serverUrl } : {}),
  };
  writeMarker(cwd, merged);
}
```

- [ ] **Step 4: Run test to verify it PASSES**

Run: `bun test tests/services/identity/project-runtime-marker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/identity/project-identity.ts tests/services/identity/project-runtime-marker.test.ts
git commit -m "feat(identity): per-project runtime fields on marker + writeProjectRuntime (no secret)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Make `selectRuntime` marker-aware (runtime-selector.ts)

**Files:**
- Modify: `src/services/hooks/runtime-selector.ts`
- Test: `tests/services/hooks/select-runtime-per-project.test.ts`

**Interfaces:**
- Consumes: `readProjectMarker` (Task 1) OR the local `readMarkerFor` extended; `loadFromFileOnce`, `normalizeRuntime` (existing).
- Produces: `selectRuntime(cwd?: string): SelectedRuntime` — marker `runtime==='server'` → `'server'`, else global fallback.

**Note (two readers):** `runtime-selector.ts` has its own private `readMarkerFor` (line ~68) returning only `{teamId, projectId}`. To avoid divergence, extend it to also read `runtime`/`serverUrl` (mirror Task 1's parsing), OR import `readProjectMarker` from `project-identity.ts`. Prefer importing `readProjectMarker` (single source of truth) unless that creates a worker/hook import-boundary violation (the file comment at line 9 warns it "deliberately does not import worker code"). Check: `project-identity.ts` imports only `credential-store` + `server-bootstrap` (no worker code), so importing `readProjectMarker` is safe. Use the import; delete/replace the local `readMarkerFor` identity-only reader if it becomes redundant, or keep it and just extend — implementer's call, but keep ONE parsing of the runtime fields.

- [ ] **Step 1: Write the failing test**

```ts
// tests/services/hooks/select-runtime-per-project.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { selectRuntime } from '../../../src/services/hooks/runtime-selector.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-rt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function marker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('selectRuntime(cwd) per-project', () => {
  it('marker runtime=server → server', () => {
    marker({ teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'http://x:1' });
    expect(selectRuntime(dir)).toBe('server');
  });
  it('marker with no runtime field → falls back to global (default local)', () => {
    marker({ teamId: 't', projectId: 'p' });
    expect(selectRuntime(dir)).toBe('local');
  });
  it('no marker at all → global default (local)', () => {
    expect(selectRuntime(dir)).toBe('local');
  });
  it('marker runtime=local → local (explicit)', () => {
    marker({ teamId: 't', projectId: 'p', runtime: 'local' });
    expect(selectRuntime(dir)).toBe('local');
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS**

Run: `bun test tests/services/hooks/select-runtime-per-project.test.ts`
Expected: FAIL — `selectRuntime` ignores the marker (current signature takes no cwd), so `runtime=server` case returns 'local'.

- [ ] **Step 3: Implement**

Add the import and rewrite `selectRuntime`:
```ts
import { readProjectMarker } from '../identity/project-identity.js';

export function selectRuntime(cwd: string = process.cwd()): SelectedRuntime {
  const marker = readProjectMarker(cwd);
  if (marker?.runtime === 'server') return 'server';
  const settings = loadFromFileOnce();
  return normalizeRuntime(settings.MEMSMITH_RUNTIME);
}
```
(If the local `readMarkerFor` was only used by `buildServerContext`, leave it; if it duplicates identity reading, the implementer may consolidate onto `readProjectMarker` — but do not change `buildServerContext`'s behavior in this task beyond what Task 3 specifies.)

- [ ] **Step 4: Run test to verify it PASSES**

Run: `bun test tests/services/hooks/select-runtime-per-project.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update the cwd-bearing callers**

The hook handlers call `selectRuntime()` with no arg. Update the three that carry a project cwd to pass it:
- `src/cli/handlers/session-init.ts` — pass the handler's `input.cwd` (or resolved cwd) to `selectRuntime(cwd)`.
- `src/cli/handlers/summarize.ts` — same.
- `src/cli/handlers/observation.ts` — same.
Grep each for `selectRuntime(` and thread the cwd already available in that handler. Do NOT change `mcp-server.ts` calls (per spec: MCP server keeps process-level resolution; `selectRuntime()` no-arg defaults to `process.cwd()`).

Run: `bunx tsc --noEmit -p tsconfig.json` → no errors (the default param keeps no-arg callers valid).

- [ ] **Step 6: Commit**

```bash
git add src/services/hooks/runtime-selector.ts \
        src/cli/handlers/session-init.ts src/cli/handlers/summarize.ts src/cli/handlers/observation.ts \
        tests/services/hooks/select-runtime-per-project.test.ts
git commit -m "feat(hooks): selectRuntime(cwd) resolves per-project runtime from marker (global fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `buildServerContext` prefers marker serverUrl + resolves key by teamId

**Files:**
- Modify: `src/services/hooks/runtime-selector.ts` (`buildServerContext`)
- Test: `tests/services/hooks/build-server-context-marker.test.ts`

**Interfaces:**
- Consumes: `readProjectMarker` (Task 1), `CredentialStore.resolveKeyForTeam(teamId)` (existing), existing global `MEMSMITH_SERVER_URL` fallback.
- Produces: `buildServerContext(cwd)` prefers the marker's `serverUrl`; resolves the API key via `CredentialStore.resolveKeyForTeam(marker.teamId)`.

- [ ] **Step 1: Read the current `buildServerContext` to preserve its contract**

Run: `sed -n '78,160p' src/services/hooks/runtime-selector.ts`
Note the existing `serverBaseUrl` resolution (`pickFirstNonEmpty(override, MEMSMITH_SERVER_URL, MEMSMITH_SERVER_BETA_URL)`) and how it currently gets the key. The change: when the project marker has `serverUrl`, it takes precedence over the global settings URL; the key comes from `CredentialStore.resolveKeyForTeam(marker.teamId)`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/services/hooks/build-server-context-marker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildServerContext } from '../../../src/services/hooks/runtime-selector.js';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';

let dir: string; let credPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-ctx-'));
  credPath = join(dir, 'credentials.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function marker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('buildServerContext with per-project marker', () => {
  it('prefers marker serverUrl and resolves key by teamId from CredentialStore', () => {
    marker({ teamId: 'team-b', projectId: 'proj-b', runtime: 'server', serverUrl: 'http://team-b:38890' });
    const store = new CredentialStore(credPath);
    store.storeKeyForTeam('team-b', 'cmem_teambkey');
    const ctx = buildServerContext({ cwd: dir, credentialStore: store });
    expect(ctx).not.toBeNull();
    expect(ctx!.serverBaseUrl).toBe('http://team-b:38890');
    // The resolved auth uses team-b's key (assert via whatever ctx exposes — apiKey/headers).
    expect(JSON.stringify(ctx)).toContain('cmem_teambkey');
  });
  it('returns null (server-not-reachable) when marker says server but no key for team', () => {
    marker({ teamId: 'team-c', projectId: 'proj-c', runtime: 'server', serverUrl: 'http://team-c:1' });
    const store = new CredentialStore(credPath); // empty
    const ctx = buildServerContext({ cwd: dir, credentialStore: store });
    expect(ctx).toBeNull();
  });
});
```
NOTE: adapt the exact `ctx` field assertions to `ServerRuntimeContext`'s real shape (read it in Step 1). The intent: marker URL wins; key resolved by teamId; missing key → null.

- [ ] **Step 3: Run test to verify it FAILS**

Run: `bun test tests/services/hooks/build-server-context-marker.test.ts`
Expected: FAIL — `buildServerContext` doesn't yet prefer the marker's serverUrl / resolve by teamId.

- [ ] **Step 4: Implement — marker precedence + key-by-teamId**

In `buildServerContext(options)`: read `const marker = readProjectMarker(options.cwd ?? process.cwd())`. Prepend `marker?.serverUrl` to the `pickFirstNonEmpty(...)` URL candidates (highest precedence, after the explicit test override). For the key: when a marker exists, resolve via `(options.credentialStore ?? new CredentialStore()).resolveKeyForTeam(marker.teamId)`; preserve the existing key path for the no-marker case. Preserve the existing null-return contract when URL or key is missing.

- [ ] **Step 5: Run test to verify it PASSES**

Run: `bun test tests/services/hooks/build-server-context-marker.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm no regression in existing runtime-selector tests**

Run: `bun test tests/services/hooks/`
Expected: green (existing buildServerContext/selectRuntime tests still pass; global-URL fallback path unchanged when no marker serverUrl).

- [ ] **Step 7: Commit**

```bash
git add src/services/hooks/runtime-selector.ts tests/services/hooks/build-server-context-marker.test.ts
git commit -m "feat(hooks): buildServerContext prefers marker serverUrl + resolves key by teamId

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Go Team flip writes the project marker

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the convert route's `flip`)
- Test: `tests/server/convert/flip-writes-marker.test.ts`

**Interfaces:**
- Consumes: `writeProjectRuntime` (Task 1), the convert route's known cwd + `authContext.teamId`.
- Produces: on Go Team, the flip calls `writeProjectRuntime(cwd, { runtime:'server', serverUrl })` and ensures the team key is in `CredentialStore` keyed by `teamId` — instead of (or in addition to, per spec) the global `writeServerModeSettings`.

**Note:** the convert route (`registerConvertRoutes`, ~line 1556) currently flips via `writeServerModeSettings({ MEMSMITH_RUNTIME:'server', MEMSMITH_SERVER_DATABASE_URL })` (global). Per the spec, the wizard flip should write the PROJECT MARKER. The cwd to use is the converting project's cwd — determine how the route knows it (the server process cwd, or a value passed in the convert input). If the convert `input` lacks a cwd, add it to the request body/handler (the wizard client knows its project cwd). Confirm during Step 1; if cwd isn't available server-side, this task adds it to the convert input contract.

- [ ] **Step 1: Read the convert route flip wiring + determine cwd availability**

Run: `sed -n '1553,1576p' src/server/routes/v1/ServerV1PostgresRoutes.ts`
Determine: does the flip have access to the converting project's cwd? If not, the wizard's `/v1/convert/migrate` request must carry it (the client — running in the project — supplies its cwd). Decide + note the exact source of `cwd` for `writeProjectRuntime`.

- [ ] **Step 2: Write the failing test**

Test the flip function in isolation (inject a `writeProjectRuntime` spy + a `CredentialStore` spy): given a convert with a target `databaseUrl`, `teamId`, and `cwd`, assert the flip calls `writeProjectRuntime(cwd, { runtime:'server', serverUrl: <derived from databaseUrl or a serverUrl input> })` and stores the key by teamId — and does NOT write global settings. (Construct the test around the actual `flip` closure or a small extracted `flipToTeam(deps, input)` helper — extract one if the closure isn't testable, keeping the route wiring thin.)

```ts
// tests/server/convert/flip-writes-marker.test.ts
import { describe, it, expect } from 'bun:test';
import { flipToTeam } from '../../../src/server/convert/flip-to-team.js'; // extract in Step 3

describe('flipToTeam', () => {
  it('writes the project marker runtime=server + serverUrl and stores key by teamId; no global settings write', () => {
    const calls: any = { marker: null, key: null, global: 0 };
    flipToTeam({
      writeProjectRuntime: (cwd, r) => { calls.marker = { cwd, ...r }; },
      storeKeyForTeam: (teamId, key) => { calls.key = { teamId, key }; },
      writeGlobalSettings: () => { calls.global++; },
    }, { cwd: '/proj/b', teamId: 'team-b', serverUrl: 'http://team-b:38890', apiKey: 'cmem_k' });
    expect(calls.marker).toEqual({ cwd: '/proj/b', runtime: 'server', serverUrl: 'http://team-b:38890' });
    expect(calls.key).toEqual({ teamId: 'team-b', key: 'cmem_k' });
    expect(calls.global).toBe(0);
  });
});
```

- [ ] **Step 3: Extract `flipToTeam` + wire it into the convert route**

Create `src/server/convert/flip-to-team.ts` — a pure-ish helper taking injected deps (`writeProjectRuntime`, `storeKeyForTeam`, optional `writeGlobalSettings`) and `{cwd, teamId, serverUrl, apiKey}`; it writes the marker + stores the key, and does NOT write global settings. Wire the convert route's `flip` to call it with real deps (`writeProjectRuntime` from project-identity, `CredentialStore#storeKeyForTeam`), sourcing `cwd`/`teamId`/`serverUrl` per Step 1's findings.

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/server/convert/flip-writes-marker.test.ts` → PASS.
Run: `bunx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/flip-to-team.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/convert/flip-writes-marker.test.ts
git commit -m "feat(convert): Go Team flip writes the project marker (runtime=server), key to CredentialStore

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Two-project isolation integration + gate

**Files:**
- Test: `tests/services/hooks/two-project-isolation.test.ts`
- (verification)

- [ ] **Step 1: Write the two-project isolation test**

```ts
// tests/services/hooks/two-project-isolation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { selectRuntime } from '../../../src/services/hooks/runtime-selector.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ms-2proj-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function proj(name: string, m: Record<string, unknown>) {
  const d = join(root, name);
  mkdirSync(join(d, '.memsmith'), { recursive: true });
  writeFileSync(join(d, '.memsmith', 'project.json'), JSON.stringify({ teamId: name, projectId: name, ...m }), 'utf-8');
  return d;
}

describe('two projects on one machine resolve independently', () => {
  it('A (no runtime) → local, B (runtime server) → server', () => {
    const a = proj('A', {});
    const b = proj('B', { runtime: 'server', serverUrl: 'http://b:1' });
    expect(selectRuntime(a)).toBe('local');
    expect(selectRuntime(b)).toBe('server');
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/services/hooks/two-project-isolation.test.ts`
Expected: PASS — the core goal proven.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Touched test set**

Run:
```bash
bun test tests/services/identity/project-runtime-marker.test.ts \
         tests/services/hooks/select-runtime-per-project.test.ts \
         tests/services/hooks/build-server-context-marker.test.ts \
         tests/server/convert/flip-writes-marker.test.ts \
         tests/services/hooks/two-project-isolation.test.ts
```
Expected: all green.

- [ ] **Step 5: Broader suites (back-compat + no regression)**

Run: `bun test tests/services/ tests/cli/handlers/ tests/server/`
Expected: green modulo the known 5 `:55432` env failures. Pay special attention to existing runtime-selector / session-init tests — they prove back-compat (no-marker → global) still holds. Record any new failure and return to the owning task.

- [ ] **Step 6: Commit the integration test**

```bash
git add tests/services/hooks/two-project-isolation.test.ts
git commit -m "test(hooks): two-project isolation — A local + B server on one machine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Marker `runtime`/`serverUrl` + `writeProjectRuntime` (no secret) → Task 1. ✅
- `selectRuntime(cwd)` marker-aware + caller cwd threading → Task 2. ✅
- `buildServerContext` marker serverUrl + key-by-teamId → Task 3. ✅
- Flip writes marker not global → Task 4. ✅
- Two-project isolation proof + back-compat gate → Task 5. ✅
- MCP-server-keeps-process-level: honored by Task 2's default-param + explicit "do NOT change mcp-server.ts". ✅

**Placeholder scan:** each task carries concrete code, tests, commands. The two spots that say "adapt to the real shape" (Task 3 ctx fields, Task 4 cwd source) are explicit read-first steps with a stated intent, not vague TODOs — they require reading one function whose exact shape I did not fully capture; the implementer reads it in the task's Step 1. Acceptable.

**Type consistency:** `ProjectMarker` fields (`runtime`/`serverUrl`) and `readProjectMarker`/`writeProjectRuntime` signatures are identical across Task 1 (def), Task 2 + Task 3 + Task 4 (consumers). `selectRuntime(cwd?: string)` default-param keeps all existing no-arg callers valid.

**Ordering:** Task 1 (marker) → Task 2 (selectRuntime reads it) → Task 3 (buildServerContext reads it) → Task 4 (flip writes it) → Task 5 (integration). Each independently testable; a reviewer can reject one without the others.
