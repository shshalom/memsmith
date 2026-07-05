# Hook Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate claude-mem's built-but-dormant determinism logic by wiring it into the real hook surface — safe-by-default so nothing changes for users who don't opt in.

**Architecture:** Reuse the team-inject bridge pattern (worker-mode hook → server `/v1/search` with a scoped key) for all memory reads. Add a `discovery-gate` handler (PreToolUse for Grep/Glob/WebSearch), re-discovery logging in the existing `observation` handler (PostToolUse), and a `subagent-start` handler (SubagentStart, project-level fallback since the payload lacks the task prompt). Every handler no-ops unless its flag is on AND the bridge is configured AND memory is found.

**Tech Stack:** TypeScript (Node 20+), claude-mem hook handlers (`src/cli/handlers/`), `plugin/hooks/hooks.json`, bun test.

## Global Constraints

- **Safe-by-default (central rule):** every activated hook returns today's result (or empty `additionalContext`) unless a feature flag is explicitly set AND the server bridge (`CLAUDE_MEM_TEAM_SERVER_URL` + `CLAUDE_MEM_TEAM_API_KEY`) is configured AND memory is found. The hook may fire; it must do nothing observable by default.
- **Never break the tool/session/subagent:** every memory path is wrapped in try/catch returning the safe default (mirror `fetchTeamMemory`).
- **`additionalContext` cap: 10,000 chars** (Claude Code PreToolUse limit) — the injection builder output must be capped.
- **Base repo, TypeScript only.** `// SPDX-License-Identifier: Apache-2.0` on new files.
- **bun test** (`import from 'bun:test'`), tests in `tests/`, per-schema isolation where DB is needed; env `CLAUDE_MEM_TEST_POSTGRES_URL`.
- **Reuse existing building blocks** — `shouldGateTool`/`buildPreToolQuery` (`pre-tool-query.ts`), `buildInjectionBlock` (`inject.ts`), `fetchTeamMemory` (`team-inject-client.ts`), `detectRediscovery` (`rediscovery.ts`). Do not reimplement.

---

### Task 1: Char-cap the injection builder

**Files:**
- Modify: `src/server/retrieval/inject.ts`
- Test: `tests/server/retrieval/inject-cap.test.ts`

**Interfaces:**
- Consumes: existing `buildInjectionBlock(deps, input)`.
- Produces: `buildInjectionBlock` accepts an optional `maxChars?: number` (default 10000); the returned block never exceeds it (truncate whole items, never mid-item).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/retrieval/inject-cap.test.ts
import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../../src/server/retrieval/inject.js';

const deps = (rows: any[]) => ({ hybridSearch: async () => rows });

describe('buildInjectionBlock char cap', () => {
  it('never exceeds maxChars, truncating whole items', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ content: 'x'.repeat(500) + `#${i}`, metadata: {} }));
    const block = await buildInjectionBlock(deps(rows), { projectId: 'p', teamId: 't', query: 'q', maxItems: 20, maxChars: 1000 });
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).toContain('Relevant team memory');
  });
  it('defaults to a 10000 char cap when maxChars omitted', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ content: 'y'.repeat(200) + `#${i}`, metadata: {} }));
    const block = await buildInjectionBlock(deps(rows), { projectId: 'p', teamId: 't', query: 'q', maxItems: 200 });
    expect(block.length).toBeLessThanOrEqual(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/shwaits/.bun/bin/bun test tests/server/retrieval/inject-cap.test.ts >/tmp/t1.log 2>&1; cat /tmp/t1.log`
Expected: FAIL — block exceeds cap (no capping yet).

- [ ] **Step 3: Implement the cap**

In `inject.ts`, add `maxChars?: number` to the input type. After building `body`/the block, if it exceeds `maxChars ?? 10000`, drop trailing items until it fits (rebuild from fewer `visible` entries; never cut mid-line). Concretely: reduce the `visible` array length by one and re-`positionForInjection` until `('## Relevant team memory (review before acting)\n' + body).length <= cap` or one item remains; hard-substring as a final guard.

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/shwaits/.bun/bin/bun test tests/server/retrieval/inject-cap.test.ts >/tmp/t1.log 2>&1; cat /tmp/t1.log`
Expected: PASS (2/2).

Regression: `/Users/shwaits/.bun/bin/bun test tests/server/retrieval/inject.test.ts >/tmp/t1r.log 2>&1; cat /tmp/t1r.log` — existing 3/3 still pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/retrieval/inject.ts tests/server/retrieval/inject-cap.test.ts
git commit -m "feat(retrieval): cap injection block at maxChars (default 10000)"
```

---

### Task 2: Discovery-gate handler (Capability 1)

**Files:**
- Create: `src/cli/handlers/discovery-gate.ts`
- Modify: `src/cli/handlers/index.ts` (register `discovery-gate` EventType)
- Test: `tests/cli/handlers/discovery-gate.test.ts`

**Interfaces:**
- Consumes: `shouldGateTool`/`buildPreToolQuery` (`pre-tool-query.ts`), `fetchTeamMemory` (`team-inject-client.ts`), `buildInjectionBlock` (`inject.ts`), settings (`CLAUDE_MEM_GATE_TOOLS`, `CLAUDE_MEM_TEAM_SERVER_URL`, `CLAUDE_MEM_TEAM_API_KEY`), `NormalizedHookInput`/`HookResult`.
- Produces: `discoveryGateHandler: EventHandler`; a pure helper `buildDiscoveryContext(deps, { toolName, toolInput, projectName, gateTools, serverUrl, apiKey }): Promise<string>` returning the injection block (or '') — the handler wraps it and returns `hookSpecificOutput.additionalContext`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/discovery-gate.test.ts
import { describe, it, expect } from 'bun:test';
import { buildDiscoveryContext } from '../../../src/cli/handlers/discovery-gate.js';

const okDeps = (rows: any[]) => ({ fetchTeamMemory: async () => rows });

describe('buildDiscoveryContext', () => {
  it('returns empty when the tool is not gated', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'x', metadata: {} }]),
      { toolName: 'TodoWrite', toolInput: { pattern: 'x' }, projectName: 'p', gateTools: 'Grep,Glob', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
  it('returns empty when bridge is unconfigured (safe-by-default)', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'auth', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: '', apiKey: '' });
    expect(ctx).toBe('');
  });
  it('returns empty when no memory found', async () => {
    const ctx = await buildDiscoveryContext(okDeps([]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
  it('injects memory when gated + configured + memory found', async () => {
    const ctx = await buildDiscoveryContext(okDeps([{ id: 'o', content: 'auth uses JWT', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toContain('auth uses JWT');
    expect(ctx).toContain('Relevant team memory');
  });
  it('never throws when the fetch rejects', async () => {
    const throwDeps = { fetchTeamMemory: async () => { throw new Error('boom'); } };
    const ctx = await buildDiscoveryContext(throwDeps,
      { toolName: 'Grep', toolInput: { pattern: 'auth' }, projectName: 'p', gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(ctx).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/shwaits/.bun/bin/bun test tests/cli/handlers/discovery-gate.test.ts >/tmp/t2.log 2>&1; cat /tmp/t2.log`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildDiscoveryContext` + the handler**

```typescript
// src/cli/handlers/discovery-gate.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { getProjectContext } from '../../utils/project-name.js';
import { shouldGateTool, buildPreToolQuery } from './pre-tool-query.js';
import { fetchTeamMemory as realFetchTeamMemory } from '../../server/retrieval/team-inject-client.js';
import { buildInjectionBlock } from '../../server/retrieval/inject.js';

export interface DiscoveryGateDeps {
  fetchTeamMemory(input: { serverUrl: string; apiKey: string; projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>;
}

export async function buildDiscoveryContext(
  deps: DiscoveryGateDeps,
  input: { toolName: string; toolInput: Record<string, unknown>; projectName: string; gateTools: string; serverUrl: string; apiKey: string },
): Promise<string> {
  try {
    if (!shouldGateTool(input.toolName, input.gateTools)) return '';
    if (!input.serverUrl.trim() || !input.apiKey.trim()) return '';
    const query = buildPreToolQuery(input.toolInput);
    if (!query) return '';
    const rows = await deps.fetchTeamMemory({ serverUrl: input.serverUrl, apiKey: input.apiKey, projectId: input.projectName, teamId: '', query, limit: 5 });
    return await buildInjectionBlock({ hybridSearch: async () => rows }, { projectId: input.projectName, teamId: '', query });
  } catch (error) {
    logger.warn('HOOK', 'discovery-gate injection failed; continuing', { error: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

export const discoveryGateHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const empty: HookResult = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '' }, exitCode: HOOK_EXIT_CODES.SUCCESS };
    if (!input.toolName) return empty;
    const settings = loadFromFileOnce();
    const context = getProjectContext(input.cwd || process.cwd());
    const additionalContext = await buildDiscoveryContext(
      { fetchTeamMemory: realFetchTeamMemory },
      {
        toolName: input.toolName,
        toolInput: (input.toolInput as Record<string, unknown>) ?? {},
        projectName: context.primary,
        gateTools: settings.CLAUDE_MEM_GATE_TOOLS ?? '',
        serverUrl: settings.CLAUDE_MEM_TEAM_SERVER_URL ?? '',
        apiKey: settings.CLAUDE_MEM_TEAM_API_KEY ?? '',
      },
    );
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
  },
};
```

Then register it in `src/cli/handlers/index.ts`: add `'discovery-gate'` to the `EventType` union, import `discoveryGateHandler`, add `'discovery-gate': discoveryGateHandler` to the `handlers` record, and re-export it.

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/shwaits/.bun/bin/bun test tests/cli/handlers/discovery-gate.test.ts >/tmp/t2.log 2>&1; cat /tmp/t2.log`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/discovery-gate.ts src/cli/handlers/index.ts tests/cli/handlers/discovery-gate.test.ts
git commit -m "feat(hooks): discovery-gate handler (PreToolUse memory injection, safe-by-default)"
```

---

### Task 3: Wire discovery-gate into hooks.json (Capability 1 activation)

**Files:**
- Modify: `plugin/hooks/hooks.json` (expand PreToolUse matcher to include Grep/Glob/WebSearch → discovery-gate)
- Test: `tests/plugin/hooks-json.test.ts`

**Interfaces:**
- Consumes: the `discovery-gate` event registered in Task 2.
- Produces: a PreToolUse hook entry (matcher `Grep|Glob|WebSearch`) invoking `hook claude-code discovery-gate`, alongside the existing `Read`→`file-context` entry (unchanged). A test validates hooks.json is well-formed and contains both entries.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/plugin/hooks-json.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('plugin/hooks/hooks.json', () => {
  const h = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf8'));
  it('is well-formed with a hooks object', () => {
    expect(h.hooks).toBeDefined();
    expect(Array.isArray(h.hooks.PreToolUse)).toBe(true);
  });
  it('keeps the existing Read -> file-context entry', () => {
    const cmds = h.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((hh: any) => hh.command));
    expect(cmds.some((c: string) => c.includes('hook claude-code file-context'))).toBe(true);
  });
  it('adds a Grep|Glob|WebSearch -> discovery-gate entry', () => {
    const gate = h.hooks.PreToolUse.find((e: any) => (e.matcher ?? '').includes('Grep'));
    expect(gate).toBeDefined();
    expect(gate.matcher).toContain('Glob');
    expect(gate.matcher).toContain('WebSearch');
    expect(gate.hooks.some((hh: any) => hh.command.includes('hook claude-code discovery-gate'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/shwaits/.bun/bin/bun test tests/plugin/hooks-json.test.ts >/tmp/t3.log 2>&1; cat /tmp/t3.log`
Expected: FAIL — no Grep matcher entry yet.

- [ ] **Step 3: Add the hooks.json entry**

In `plugin/hooks/hooks.json`, under `hooks.PreToolUse`, add a second array entry (after the existing `Read` entry) with `"matcher": "Grep|Glob|WebSearch"` and a `hooks` array whose command mirrors the existing PreToolUse command EXACTLY (the long bun-runner bash preamble) but ends with `hook claude-code discovery-gate` instead of `hook claude-code file-context`. Copy the existing entry's command verbatim and change only the trailing event name. Keep `"timeout": 60`.

> The command string is identical to the existing PreToolUse(Read) entry except the final `hook claude-code file-context` → `hook claude-code discovery-gate`. Do not hand-write the bash preamble — copy it.

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/shwaits/.bun/bin/bun test tests/plugin/hooks-json.test.ts >/tmp/t3.log 2>&1; cat /tmp/t3.log`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/hooks.json tests/plugin/hooks-json.test.ts
git commit -m "feat(hooks): activate discovery-gate on PreToolUse Grep/Glob/WebSearch"
```

---

### Task 4: Re-discovery logging in the observation handler (Capability 2)

**Files:**
- Modify: `src/cli/handlers/observation.ts`
- Test: `tests/cli/handlers/rediscovery-log.test.ts`

**Interfaces:**
- Consumes: `detectRediscovery` (`rediscovery.ts`), `buildPreToolQuery`/`shouldGateTool` (`pre-tool-query.ts`), `fetchTeamMemory`, settings (`CLAUDE_MEM_REDISCOVERY_LOG`, bridge vars).
- Produces: a pure helper `shouldLogRediscovery(deps, { toolName, toolInput, projectName, enabled, gateTools, serverUrl, apiKey }): Promise<{ rediscovered: boolean; matchedIds: string[] }>`; the observation handler calls it after its existing path and `logger.info`s on a hit. Never blocks, never changes the response.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/rediscovery-log.test.ts
import { describe, it, expect } from 'bun:test';
import { shouldLogRediscovery } from '../../../src/cli/handlers/observation.js';

const deps = (rows: any[]) => ({ fetchTeamMemory: async () => rows });

describe('shouldLogRediscovery', () => {
  it('flags when enabled + gated + configured + memory held a match', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'PaymentService retries', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'PaymentService' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(true);
    expect(r.matchedIds).toContain('o1');
  });
  it('does not flag when disabled (default)', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'x', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: false, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(false);
  });
  it('does not flag when bridge unconfigured', async () => {
    const r = await shouldLogRediscovery(deps([{ id: 'o1', content: 'x', metadata: {} }]),
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: '', apiKey: '' });
    expect(r.rediscovered).toBe(false);
  });
  it('never throws when fetch rejects', async () => {
    const r = await shouldLogRediscovery({ fetchTeamMemory: async () => { throw new Error('x'); } },
      { toolName: 'Grep', toolInput: { pattern: 'x' }, projectName: 'p', enabled: true, gateTools: 'Grep', serverUrl: 'u', apiKey: 'k' });
    expect(r.rediscovered).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/Users/shwaits/.bun/bin/bun test tests/cli/handlers/rediscovery-log.test.ts >/tmp/t4.log 2>&1; cat /tmp/t4.log`
Expected: FAIL — `shouldLogRediscovery` not exported.

- [ ] **Step 3: Implement + wire**

Add to `src/cli/handlers/observation.ts` (export the helper, import deps):

```typescript
import { shouldGateTool, buildPreToolQuery } from './pre-tool-query.js';
import { detectRediscovery } from '../../server/retrieval/rediscovery.js';
import { fetchTeamMemory as realFetchTeamMemory } from '../../server/retrieval/team-inject-client.js';

export interface RediscoveryLogDeps {
  fetchTeamMemory(input: { serverUrl: string; apiKey: string; projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>;
}

export async function shouldLogRediscovery(
  deps: RediscoveryLogDeps,
  input: { toolName: string; toolInput: Record<string, unknown>; projectName: string; enabled: boolean; gateTools: string; serverUrl: string; apiKey: string },
): Promise<{ rediscovered: boolean; matchedIds: string[] }> {
  try {
    if (!input.enabled) return { rediscovered: false, matchedIds: [] };
    if (!shouldGateTool(input.toolName, input.gateTools)) return { rediscovered: false, matchedIds: [] };
    if (!input.serverUrl.trim() || !input.apiKey.trim()) return { rediscovered: false, matchedIds: [] };
    const toolQuery = buildPreToolQuery(input.toolInput);
    if (!toolQuery) return { rediscovered: false, matchedIds: [] };
    return await detectRediscovery(
      { hybridSearch: async () => deps.fetchTeamMemory({ serverUrl: input.serverUrl, apiKey: input.apiKey, projectId: input.projectName, teamId: '', query: toolQuery, limit: 3 }) },
      { projectId: input.projectName, teamId: '', toolQuery, toolResult: '' },
    );
  } catch {
    return { rediscovered: false, matchedIds: [] };
  }
}
```

Then in the observation handler's `execute`, AFTER the existing observation-send path (do not change it), add a best-effort call:

```typescript
try {
  const settings = loadFromFileOnce();  // if not already loaded in this handler
  const context = getProjectContext(cwd);
  const r = await shouldLogRediscovery(
    { fetchTeamMemory: realFetchTeamMemory },
    { toolName: toolName ?? '', toolInput: (toolInput as Record<string, unknown>) ?? {}, projectName: context.primary,
      enabled: settings.CLAUDE_MEM_REDISCOVERY_LOG === 'true',
      gateTools: settings.CLAUDE_MEM_GATE_TOOLS ?? '', serverUrl: settings.CLAUDE_MEM_TEAM_SERVER_URL ?? '', apiKey: settings.CLAUDE_MEM_TEAM_API_KEY ?? '' },
  );
  if (r.rediscovered) logger.info('HOOK', 'rediscovery: memory already held an answer for this discovery query', { toolName, matchedIds: r.matchedIds });
} catch { /* never break observation */ }
```

Add `CLAUDE_MEM_REDISCOVERY_LOG: string;` to `SettingsDefaultsManager` interface + defaults (`'false'`). Import `loadFromFileOnce`/`getProjectContext` in observation.ts if not present.

- [ ] **Step 4: Run test to verify it passes**

Run: `/Users/shwaits/.bun/bin/bun test tests/cli/handlers/rediscovery-log.test.ts >/tmp/t4.log 2>&1; cat /tmp/t4.log`
Expected: PASS (4/4). Regression: `/Users/shwaits/.bun/bin/bun test tests/cli/handlers/ >/tmp/t4r.log 2>&1; tail -3 /tmp/t4r.log` — existing handler tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/observation.ts src/shared/SettingsDefaultsManager.ts tests/cli/handlers/rediscovery-log.test.ts
git commit -m "feat(hooks): re-discovery logging in observation handler (default off, never blocks)"
```

---

## Deferred (documented, NOT in this plan)

**Capability 3 (SubagentStart injection):** the SubagentStart payload carries `agent_type` but NOT the task prompt (verified against Claude Code hook docs). So it can only inject project-level memory (no task-scoping). It is lower value than Capabilities 1-2 and adds a net-new hook entry. Deferred to a follow-up plan; if built, it reuses the same bridge + `buildInjectionBlock` pattern keyed on `context.primary` (project) with `agent_type` as a weak query hint.

## Self-Review

**Spec coverage** (against the design doc):
- Safe-by-default (flag + bridge + memory) → every task's helper checks all three ✅
- Never-break → try/catch in every handler path ✅
- 10k cap → Task 1 ✅
- Capability 1 (discovery-gate) → Tasks 2 + 3 ✅
- Capability 2 (re-discovery log) → Task 4 ✅
- Capability 3 → explicitly deferred with rationale ✅

**Placeholder scan:** no TBD/TODO; every code step has real code; hooks.json step says "copy the existing command verbatim, change only the trailing event name" (concrete, not a placeholder). ✅

**Type consistency:** `buildDiscoveryContext`/`shouldLogRediscovery` DI deps both shape `fetchTeamMemory` identically to the real `fetchTeamMemory` signature; `shouldGateTool(name, override)` / `buildPreToolQuery(input)` match `pre-tool-query.ts`; `buildInjectionBlock(deps, input)` matches `inject.ts` (with Task 1's `maxChars`); `detectRediscovery(deps, input)` matches `rediscovery.ts`. ✅

## Execution Handoff

Plan complete. Execute via `superpowers:subagent-driven-development` (recommended) — fresh subagent per task + review. Prerequisite: on a branch off `main`; test Postgres not required for Tasks 1-2-4 (DI/fake fetch) but the bun test runner is.
