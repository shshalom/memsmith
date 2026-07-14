# Dashboard Affordances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the MemSmith dashboard URL in the SessionStart context injection (even on empty projects) and add an `/ms-dashboard` skill to open it.

**Architecture:** Additive, read-only. A shared pure `resolveDashboardUrl()` helper is the single source of the URL; `context.ts` prepends a dashboard line using the same prepend pattern as the existing stale-OAuth hint; a new `ms-dashboard` skill surfaces/opens the URL.

**Tech Stack:** TypeScript, Bun (test), Claude Code plugin skills.

**Spec:** `docs/superpowers/specs/2026-07-13-dashboard-affordances-design.md`

## Global Constraints

- **URL derivation is UID-based:** port = `MEMSMITH_SERVER_PORT` (if a positive integer) else `38877 + (process.getuid?.() ?? 77) % 100`; URL = `http://127.0.0.1:<port>`. Mirror the private `getServerPort()` at `src/server/runtime/ServerService.ts:865`. Do NOT hardcode a port literal in the injection path — use the shared helper.
- **Injection must never break:** `resolveDashboardUrl()` is pure/total (uid fallback 77, never throws). The dashboard line lives in `context.ts` (the handler), NOT inside `buildInjectionBlock` (which returns `''` on empty memory) — so it shows even on a new project.
- **Skill naming:** the new skill is `ms-dashboard` (dir + `name:` frontmatter must match), keeping the `ms-` namespace the separation work established. The existing `tests/plugin/skill-namespace-separation.test.ts` guard must still pass (it will now count 18 skills).
- **Do NOT** add anything to Claude Code's `/plugin` page (impossible; out of scope).
- Never rename keep-list deps (`claude-code`, `claude-agent`, `@anthropic-ai/*`).
- Bun clean-env: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun ...`
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `dashboard-affordances`. Do not push. Do NOT `git checkout <hash>` (detaches HEAD).

---

### Task 1: Shared `resolveDashboardUrl()` helper

**Files:**
- Create: `src/shared/dashboard-url.ts`
- Test: `tests/shared/dashboard-url.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveDashboardUrl(): string` → `http://127.0.0.1:<port>`.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/dashboard-url.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { resolveDashboardUrl } from '../../src/shared/dashboard-url.js';

describe('resolveDashboardUrl', () => {
  afterEach(() => { delete process.env.MEMSMITH_SERVER_PORT; });

  it('uses the UID-derived port when MEMSMITH_SERVER_PORT is unset', () => {
    delete process.env.MEMSMITH_SERVER_PORT;
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });

  it('honors MEMSMITH_SERVER_PORT when set to a positive integer', () => {
    process.env.MEMSMITH_SERVER_PORT = '45123';
    expect(resolveDashboardUrl()).toBe('http://127.0.0.1:45123');
  });

  it('ignores a non-integer MEMSMITH_SERVER_PORT and falls back to UID-derived', () => {
    process.env.MEMSMITH_SERVER_PORT = 'not-a-number';
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });

  it('ignores an empty MEMSMITH_SERVER_PORT and falls back to UID-derived', () => {
    process.env.MEMSMITH_SERVER_PORT = '';
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/dashboard-url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/shared/dashboard-url.ts`:

```typescript
// Single source of the local MemSmith dashboard/viewer URL. Mirrors the private
// getServerPort() in src/server/runtime/ServerService.ts so the SessionStart
// injection line and the ms-dashboard skill resolve the same URL without
// reaching into that private function or hardcoding a port. Pure + total:
// never throws (uid fallback 77), safe to call from the injection hot path.
const DEFAULT_SERVER_PORT = 38877;

export function resolveDashboardPort(): number {
  const parsed = Number.parseInt(process.env.MEMSMITH_SERVER_PORT ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_SERVER_PORT + ((process.getuid?.() ?? 77) % 100);
}

export function resolveDashboardUrl(): string {
  return `http://127.0.0.1:${resolveDashboardPort()}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/dashboard-url.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/shared/dashboard-url.ts tests/shared/dashboard-url.test.ts
git commit -m "$(printf 'feat(dashboard): resolveDashboardUrl shared helper (UID-derived port)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Prepend the dashboard line in the SessionStart injection

**Files:**
- Modify: `src/cli/handlers/context.ts` (the `contextHandler.execute`, after `additionalContext` is resolved and after the stale-OAuth hint block)
- Test: `tests/context/dashboard-link-injection.test.ts` (create; if a context.ts test harness already exists under `tests/context/`, extend it instead — check first)

**Interfaces:**
- Consumes: `resolveDashboardUrl` from `src/shared/dashboard-url.js` (Task 1).
- Produces: an injected `additionalContext` string that begins with the dashboard line.

- [ ] **Step 1: Write the failing test**

Check for an existing context handler test first: `ls tests/context/ 2>/dev/null; grep -rln "contextHandler\|context.ts" tests/ --include="*.ts" | head`. If one exists that already sets up `setContextDependenciesForTesting`, extend it; otherwise create `tests/context/dashboard-link-injection.test.ts` following that harness. The test must assert the dashboard line appears BOTH when memory is non-empty and when it's empty.

Reference shape (adapt to the real `setContextDependenciesForTesting` signature in `src/cli/handlers/context.ts`):

```typescript
import { describe, it, expect, afterEach } from 'bun:test';
import { contextHandler, setContextDependenciesForTesting } from '../../src/cli/handlers/context.js';
import { resolveDashboardUrl } from '../../src/shared/dashboard-url.js';

// Build a fake dependency set that returns a fixed primary-injection string.
// Match the real setContextDependenciesForTesting shape (getProjectContext,
// resolveRuntimeContext, loadFromFileOnce, getProjectContext.primary, etc.).
function installDeps(primaryInjection: string) {
  setContextDependenciesForTesting({
    getProjectContext: () => ({ primary: 'proj', allProjects: ['proj'] }),
    loadFromFileOnce: () => ({ MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' } as any),
    // resolveRuntimeContext + the injection fetch return the fixed string:
    resolveRuntimeContext: () => ({ runtime: 'local', reason: 'test' } as any),
    // If the handler fetches via a helper, stub it to return primaryInjection.
    // (Adapt to the actual injected seam; the goal is: additionalContext == primaryInjection before the dashboard line is prepended.)
  } as any);
}

describe('dashboard link in SessionStart injection', () => {
  afterEach(() => { /* reset deps if the harness supports it */ });

  it('prepends the dashboard line when memory is non-empty', async () => {
    installDeps('## Relevant team memory\n- something');
    const res = await contextHandler.execute({ cwd: '/tmp/x' } as any);
    const ctx = (res as any).hookSpecificOutput?.additionalContext ?? (res as any).additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
    expect(ctx).toContain(resolveDashboardUrl());
    expect(ctx).toContain('something'); // memory still present
  });

  it('still shows the dashboard line when memory is empty', async () => {
    installDeps('');
    const res = await contextHandler.execute({ cwd: '/tmp/x' } as any);
    const ctx = (res as any).hookSpecificOutput?.additionalContext ?? (res as any).additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
    expect(ctx).toContain(resolveDashboardUrl());
  });
});
```

Note to implementer: the exact `setContextDependenciesForTesting` shape and `HookResult` field (`hookSpecificOutput.additionalContext` vs a flat field) must be read from `src/cli/handlers/context.ts`. Adapt the harness/assertions to the REAL shapes — the binding assertion is: the returned injected string contains `📊 MemSmith dashboard:` + `resolveDashboardUrl()`, in both the non-empty and empty-memory cases.

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/context/dashboard-link-injection.test.ts`
Expected: FAIL — no dashboard line yet.

- [ ] **Step 3: Add the import**

In `src/cli/handlers/context.ts`, add near the existing imports:

```typescript
import { resolveDashboardUrl } from '../../shared/dashboard-url.js';
```

- [ ] **Step 4: Prepend the dashboard line**

In `contextHandler.execute`, AFTER `additionalContext` is fully resolved (including the stale-OAuth hint handling that does `` `${hint}\n\n${additionalContext}` ``) and BEFORE the terminal-output/timeline section, prepend the dashboard line using the same pattern:

```typescript
    // Always surface the dashboard link at session start — even on an empty
    // project (buildInjectionBlock returns '' with no memory, but the link is
    // most useful exactly then). resolveDashboardUrl is pure/total.
    const dashboardLine = `📊 MemSmith dashboard: ${resolveDashboardUrl()}`;
    additionalContext = additionalContext
      ? `${dashboardLine}\n\n${additionalContext}`
      : dashboardLine;
```

Place this so it applies to the model-facing `additionalContext` that the handler returns. Do not also inject it into the Codex color-timeline path unless that path shares the same `additionalContext` variable (it renders separately; leave it). Keep it to ONE occurrence.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/context/dashboard-link-injection.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Typecheck**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty.

- [ ] **Step 7: Commit**

```bash
git add src/cli/handlers/context.ts tests/context/dashboard-link-injection.test.ts
git commit -m "$(printf 'feat(dashboard): surface dashboard URL in SessionStart injection (shows even on empty project)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `/ms-dashboard` skill

**Files:**
- Create: `plugin/skills/ms-dashboard/SKILL.md`
- Test: none new (the existing `tests/plugin/skill-namespace-separation.test.ts` guard covers it; Step 4 runs it)

**Interfaces:**
- Consumes: the URL derivation (the skill computes it in its instructions).
- Produces: a registered `ms-dashboard` skill.

- [ ] **Step 1: Create the skill**

Create `plugin/skills/ms-dashboard/SKILL.md` (match the existing skills' frontmatter format — `name:` must equal the dir name `ms-dashboard`):

```markdown
---
name: ms-dashboard
description: Open the MemSmith dashboard (memory viewer, metrics, and cost panel) in the browser. Use when the user asks to open/see/view the MemSmith dashboard, viewer, or memory UI.
---

# MemSmith Dashboard

Open the local MemSmith dashboard for this machine.

## Resolve the URL

The dashboard is served by the local MemSmith server on a UID-derived port:

- If `MEMSMITH_SERVER_PORT` is set to a positive integer, the port is that value.
- Otherwise the port is `38877 + (uid % 100)`, where `uid` is the current user's numeric id (`id -u`).

Compute the URL as `http://127.0.0.1:<port>`. For example:

```bash
PORT="${MEMSMITH_SERVER_PORT:-$((38877 + $(id -u) % 100))}"
echo "http://127.0.0.1:$PORT"
```

## Open it

- On macOS: `open "http://127.0.0.1:$PORT"`.
- On Linux: `xdg-open "http://127.0.0.1:$PORT"` (or just print the URL).
- Otherwise: print the URL as a clickable link for the user.

If the page does not load, the local MemSmith server may not be running — starting a new Claude Code session in a MemSmith-tracked project boots it.
```

- [ ] **Step 2: Verify the skill dir + frontmatter match**

Run: `test -f plugin/skills/ms-dashboard/SKILL.md && grep -q '^name: ms-dashboard$' plugin/skills/ms-dashboard/SKILL.md && echo OK`
Expected: `OK`.

- [ ] **Step 3: Run the namespace guard (now 18 skills)**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/plugin/skill-namespace-separation.test.ts`
Expected: PASS. NOTE: this test asserts an exact skill COUNT (it was 17). Update that expected count from 17 → 18 in `tests/plugin/skill-namespace-separation.test.ts` (the `expect(dirs.length).toBe(17)` assertion) as part of this task, since adding a skill is the intended change. Re-run until green.

- [ ] **Step 4: Commit**

```bash
git add plugin/skills/ms-dashboard tests/plugin/skill-namespace-separation.test.ts
git commit -m "$(printf 'feat(dashboard): add ms-dashboard skill to open the dashboard URL\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Final: build + verify

After all 3 tasks, run a clean build-and-sync so the plugin bundle + marketplace reflect the new skill + injection, and confirm nothing regressed:

- `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit` → clean.
- `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin:$HOME/.bun/bin npm run build-and-sync` → "Sync complete!", and `plugin/skills/ms-dashboard/SKILL.md` synced; `.mcp.json` still present in marketplace (regression check for the earlier sync fix).
- Full suite: no new failures beyond the known pre-existing baseline (~29).

## Notes for the executor

- Tasks are a chain: 2 consumes 1; 3 is independent but shares the same URL logic (kept in sync by the spec, not by import — the skill is shell/markdown).
- The dashboard line is cosmetic/additive; the one correctness rule is it must NOT break injection (pure helper, prepend pattern, shows-on-empty).
- Don't hardcode `38879` anywhere — always derive.
