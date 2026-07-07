# Per-Prompt Hybrid Injection (Determinism 9A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a team server is configured, route per-prompt (`UserPromptSubmit`) memory injection through the same hybrid-RRF + L0–L3-tiered path (`fetchTeamMemory` → `buildInjectionBlock`) that SessionStart/PreToolUse use, querying with the prompt text; leave worker-only installs on their existing `/api/context/semantic` path unchanged.

**Architecture:** One change site — the `UserPromptSubmit` branch of `src/cli/handlers/session-init.ts`. Add a server-mode branch (gated on `MEMSMITH_TEAM_SERVER_URL` + `MEMSMITH_TEAM_API_KEY`) that runs before the existing worker semantic call and falls through to it on empty/error. `fetchTeamMemory` is injected as a testable dependency.

**Tech Stack:** TypeScript, bun:test. No DB, no live server (deps mocked). No schema change, no hook-wiring change.

## Global Constraints

- Safe-by-default: with NO team server configured, behavior is byte-identical to today (existing `/api/context/semantic` path). This is an install-active hook — a plain worker install must see zero change.
- Reuse existing gates/flags: `MEMSMITH_TEAM_SERVER_URL`, `MEMSMITH_TEAM_API_KEY` (server gate, same as SessionStart), `MEMSMITH_SEMANTIC_INJECT`, `MEMSMITH_SEMANTIC_INJECT_LIMIT`, `MEMSMITH_TIERING`. NO new env flag.
- Server-mode query MUST be the user prompt text (the signal improvement), not the project name.
- Injection MUST NEVER break the prompt hook: `fetchTeamMemory` returns [] on any error; the server branch is wrapped so any throw logs and falls through to the worker path; total failure returns `{ continue: true }` (no injection), as today.
- The prompt injectability gate (`prompt.length >= 20`, not `[media prompt]`, `semanticInject` on) is preserved and applies to both paths.
- `session-init.ts` is bundled into `plugin/scripts/worker-service.cjs` — after the src change, `npm run build` and commit the regenerated bundle(s).

---

## Task 1: Route per-prompt injection through hybrid+tiering when a team server is configured

**Files:**
- Modify: `src/cli/handlers/session-init.ts` (the `UserPromptSubmit` handler, ~lines 147-160; the injected `dependencies` object ~lines 38-46; the `setSessionInitDependenciesForTesting` setter)
- Test: `tests/cli/handlers/session-init-per-prompt-hybrid.test.ts`

**Interfaces:**
- Consumes: `fetchTeamMemory({ serverUrl, apiKey, projectId, teamId, query }): Promise<TeamMemoryRow[]>` from `../../server/retrieval/team-inject-client.js`; `buildInjectionBlock(deps, { projectId, teamId, query, maxItems?, maxChars? })` from `../../server/retrieval/inject.js`.
- Produces: no new exported signature; adds `fetchTeamMemory` to the internal `dependencies` object so tests can inject a stub, and a local `teamServerConfigured(settings)` gate.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/handlers/session-init-per-prompt-hybrid.test.ts`. MIRROR the mock setup in the existing `tests/cli/handlers/session-init-semantic-platform-source.test.ts` (it imports `sessionInitHandler` + `setSessionInitDependenciesForTesting`, stubs `loadFromFileOnce` to return settings, and stubs `executeWithWorkerFallback`/`isWorkerFallback`). Read that file first and copy its harness shape. Add `fetchTeamMemory` to the injected deps.

Cover (from spec):
```
1. server-configured -> fetchTeamMemory called with query === the prompt (NOT project);
   additionalContext is the buildInjectionBlock output; worker fetch NOT used.
2. server NOT configured -> fetchTeamMemory NOT called; existing worker
   /api/context/semantic result returned unchanged (regression guard).
3. server configured but fetchTeamMemory returns [] -> falls through to worker path
   (worker semantic block returned, not empty).
4. server-mode query is the prompt text (explicit assert on the query arg).
5. injectability gate: a <20-char prompt injects nothing on EITHER path.
6. server branch throws -> caught; handler returns a valid { continue: true } result.
```
Each test asserts on the returned `hookSpecificOutput.additionalContext` and on which dep was called (spy/among the injected deps).

- [ ] **Step 2: Run test, verify it fails**

Run: `~/.bun/bin/bun test tests/cli/handlers/session-init-per-prompt-hybrid.test.ts`
Expected: FAIL — server-mode branch doesn't exist; `fetchTeamMemory` not a dep / not called.

- [ ] **Step 3: Add `fetchTeamMemory` to deps + `teamServerConfigured` gate**

In `session-init.ts`:
- Import `fetchTeamMemory` and `buildInjectionBlock` (and the `Settings`/config type already used).
- Add `fetchTeamMemory: defaultFetchTeamMemory` and `buildInjectionBlock: defaultBuildInjectionBlock` to the `defaultDependencies` object so both are override-injectable (mirror how `executeWithWorkerFallback` is injected). Import the defaults under aliases as the file already does for the worker-fallback fns.
- Add a module-local helper:
```ts
function teamServerConfigured(settings: Record<string, string | undefined>): boolean {
  return !!(settings.MEMSMITH_TEAM_SERVER_URL?.trim() && settings.MEMSMITH_TEAM_API_KEY?.trim());
}
```

- [ ] **Step 4: Add the server-mode branch in the UserPromptSubmit handler**

Replace the current semantic-inject block (the `if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') { ... }` body) with a server-first, worker-fallback structure:

```ts
if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
  // Server mode (team server configured): hybrid RRF + L0–L3 tiering, query = the
  // actual prompt (higher signal than SessionStart's project-name query). Mirrors
  // the SessionStart team-injection block. fetchTeamMemory never throws (returns []),
  // and buildInjectionBlock returns '' on empty, so a down/misconfigured server
  // degrades to the worker path below — never an empty injection where the worker
  // could have served one.
  if (teamServerConfigured(settings)) {
    try {
      const rows = await dependencies.fetchTeamMemory({
        serverUrl: settings.MEMSMITH_TEAM_SERVER_URL ?? '',
        apiKey: settings.MEMSMITH_TEAM_API_KEY ?? '',
        projectId: project,
        teamId: '',            // resolved server-side from the scoped key
        query: prompt,         // the signal improvement: query with the prompt
      });
      const block = await dependencies.buildInjectionBlock(
        { hybridSearch: async () => rows },
        { projectId: project, teamId: '', query: prompt },
      );
      if (block) additionalContext = block;
    } catch (error) {
      logger.warn('HOOK', 'per-prompt hybrid injection failed; falling back to worker semantic', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Worker semantic path — unchanged; runs when no team server, or the server
  // path produced nothing.
  if (!additionalContext) {
    const limit = settings.MEMSMITH_SEMANTIC_INJECT_LIMIT || '5';
    const semanticResult = await dependencies.executeWithWorkerFallback<SemanticContextResponse>(
      '/api/context/semantic', 'POST', { q: prompt, project, limit, platformSource },
    );
    if (!dependencies.isWorkerFallback(semanticResult) && semanticResult?.context) {
      logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
      additionalContext = semanticResult.context;
    }
  }
}
```

Keep everything after (`if (additionalContext) { return { ...hookSpecificOutput } }`) exactly as-is.

- [ ] **Step 5: Run test, verify it passes**

Run: `~/.bun/bin/bun test tests/cli/handlers/session-init-per-prompt-hybrid.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Verify no regression in existing session-init tests**

Run: `~/.bun/bin/bun test tests/cli/handlers/session-init-semantic-platform-source.test.ts tests/cli/handlers/session-init-server-beta-context.test.ts`
Expected: all PASS. The no-team-server test (#2) is the regression guard — the worker path must be untouched when no server is configured. If either existing test breaks, the change altered the default worker path — fix before proceeding (do NOT edit the existing tests to pass).

- [ ] **Step 7: Rebuild bundle + commit**

```bash
npm run build
git add src/cli/handlers/session-init.ts tests/cli/handlers/session-init-per-prompt-hybrid.test.ts plugin/scripts/*.cjs
git commit -m "feat(hook): per-prompt injection uses hybrid+tiering when a team server is configured"
```

---

## Task 2: Docs — capability status

**Files:**
- Modify: `docs/deploy/aws.md` (note in the relevant env rows) — OPTIONAL if a natural spot exists; otherwise skip to PROJECT-STATE only.

**Interfaces:** none (docs).

- [ ] **Step 1: Note the unified per-prompt path**

If `docs/deploy/aws.md` documents `MEMSMITH_TEAM_SERVER_URL` or `MEMSMITH_SEMANTIC_INJECT`, add a one-line note that when a team server is configured, per-prompt (`UserPromptSubmit`) injection uses the hybrid+tiered path (same as SessionStart), querying with the prompt; worker-only installs use the SQLite semantic path. If no natural row exists, add a short note beside the `MEMSMITH_TEAM_SERVER_URL` row.

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/aws.md
git commit -m "docs: per-prompt hybrid injection uses the team-server path when configured"
```

---

## Self-Review

**1. Spec coverage:**
- Server-mode branch (hybrid+tiered, query=prompt) → Task 1 Step 4 ✅
- Worker fallback unchanged / safe-by-default → Task 1 Step 4 (server-first, `if (!additionalContext)` worker) + test #2 ✅
- Gating on both team vars → `teamServerConfigured` (Task 1 Step 3) ✅
- Query is the prompt not the project → Step 4 + test #4 ✅
- Never breaks the hook (fetchTeamMemory []-on-error, try/catch fallthrough) → Step 4 + test #6 ✅
- Injectability gate preserved → Step 4 (outer if kept) + test #5 ✅
- Inherits private-filter/tiering/off-switch via buildInjectionBlock → reuse in Step 4 (spec test 7; covered structurally by using the shared builder) ✅
- All 7 spec tests mapped (6 explicit in Task 1 Step 1; #7 inherited-behavior is satisfied by routing through buildInjectionBlock — no separate assertion needed since Task-3-of-the-tiering-feature already proved the builder's private/tiering behavior). ✅
- No new env flag, no hook-wiring change, no schema change → Global Constraints ✅

**2. Placeholder scan:** No TBD/TODO. Step 4 has the complete replacement block; Step 1 enumerates the 6 concrete test cases with their assertions (mirroring an existing test's harness, named).

**3. Type consistency:** `fetchTeamMemory` args `{ serverUrl, apiKey, projectId, teamId, query }` match team-inject-client.ts. `buildInjectionBlock(deps, { projectId, teamId, query })` matches inject.ts (deps = `{ hybridSearch }`). `teamServerConfigured(settings)` gate uses the same two vars SessionStart checks. Deps object extension mirrors the existing `executeWithWorkerFallback` injection pattern.
