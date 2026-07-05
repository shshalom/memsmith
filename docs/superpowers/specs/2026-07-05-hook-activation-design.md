# Hook Activation — Design

**Status: FINAL — D1-D3 resolved (D3 verified against Claude Code hook docs). Ready for implementation plan.**

## Goal

Activate the Sprint-3 determinism logic that is built-but-dormant, by wiring it into claude-mem's real hook surface (`plugin/hooks/hooks.json` + handlers). Three capabilities:
1. **Discovery-gate injection** — before an expensive re-discovery tool (Grep/Glob/WebSearch/Read) runs, inject relevant memory so the agent reviews memory first.
2. **PostToolUse re-discovery detection** — after such a tool runs, flag (log/meter, never block) when memory already held the answer.
3. **Subagent-spawn injection** — a spawned subagent starts already holding task-relevant memory.

## The hard constraint: active-on-install

Unlike the flag-gated features shipped so far (`CLAUDE_MEM_TEAM_INJECT`, `CLAUDE_MEM_SEARCH_HYBRID`), a `hooks.json` change fires for **every claude-mem user the moment they update** — there is no per-user opt-in at the hook-registration layer. Therefore:

**Every new/expanded hook MUST be safe-by-default: the handler no-ops (returns the same result as today, or empty `additionalContext`) unless a feature flag is explicitly enabled AND relevant memory is found.** The hook may fire, but it must do nothing observable by default. This is the central design rule.

## What already exists (dormant building blocks)
- `shouldGateTool` / `buildPreToolQuery` (`src/cli/handlers/pre-tool-query.ts`) — decide gating + derive a query.
- `detectRediscovery` (`src/server/retrieval/rediscovery.ts`) — pure detector.
- `buildInjectionBlock` (`inject.ts`), `positionForInjection` (`positioning.ts`).
- `fetchTeamMemory` (`team-inject-client.ts`) — worker→server /v1/search bridge (the pattern for reaching Postgres memory from a worker-mode hook).
- Hook registry: `src/cli/handlers/index.ts` (EventType union + handlers record). Current map (from `plugin/hooks/hooks.json`): SessionStart→context, UserPromptSubmit→session-init, PostToolUse(*)→observation, PreToolUse(Read)→file-context, Stop→summarize.

## Architecture (chosen approach)

**Reuse the team-inject bridge pattern for all memory reads.** The hooks run in worker mode; team/project memory lives in server-mode Postgres. Rather than give the worker a Postgres connection, each activated hook fetches via the already-authed server API (`/v1/search`) with the scoped read key + flags already added (`CLAUDE_MEM_TEAM_SERVER_URL`, `CLAUDE_MEM_TEAM_API_KEY`). If those aren't configured, every activated hook is inert — which doubles as the safe-by-default guarantee.

### Capability 1 — discovery-gate injection (lowest risk)
- **hooks.json:** expand the `PreToolUse` matcher from `Read` to `Read|Grep|Glob|WebSearch`, routed to the existing `file-context` event (or a new `discovery-gate` event — see decision D1).
- **handler:** on a gated tool, `q = buildPreToolQuery(toolInput)`; if `shouldGateTool(toolName, env) && q`, fetch memory via the bridge, build an injection block, return it as `additionalContext`. Otherwise return empty (today's behavior for non-Read).
- **safe-by-default:** inert unless `CLAUDE_MEM_GATE_TOOLS` is set (or defaulted-on — decision D2) AND the bridge is configured AND memory is found.

### Capability 2 — PostToolUse re-discovery (medium risk — modifies an active handler)
- **hooks.json:** no change (PostToolUse(*)→observation already fires).
- **handler:** in the `observation` handler, after the existing observation-generation path, if the tool was a gated discovery tool, call `detectRediscovery` and `logger.info('rediscovery', {...})` on a hit. Never blocks, never changes the response.
- **safe-by-default:** gated behind a flag (`CLAUDE_MEM_REDISCOVERY_LOG`, default off); a pure add of a log line, no behavioral change.

### Capability 3 — subagent-spawn injection (highest risk — net-new hook)
- **hooks.json:** add a `SubagentStart` (or the correct Claude Code event name — decision D3, MUST verify the payload shape before building) entry → new `subagent-start` event.
- **handler:** derive query from the subagent task/prompt (`subagentInjectQuery`), fetch via bridge, return `additionalContext`.
- **safe-by-default:** inert unless bridge configured + memory found.

## Data flow (all three)
`hook fires → derive query → (flag + bridge configured?) → fetchTeamMemory(/v1/search) → buildInjectionBlock → additionalContext / log`. Any missing gate → return today's result unchanged.

## Error handling
Every activated handler wraps the memory path in try/catch returning the safe default (like the team-inject bridge) — a memory failure must NEVER break a tool call, session, or subagent spawn.

## Testing
- Unit: each handler's gating/no-op logic with a fake bridge (flag off → empty; flag on + no memory → empty; flag on + memory → block). Reuse the DI/fake-fetch pattern from `team-inject-client.test.ts`.
- Regression: existing `file-context` / `observation` handler tests must pass unchanged (proves default behavior preserved).
- Manual: a hooks.json lint/validation that the JSON is well-formed and matchers are valid.

## Decisions (RESOLVED)
- **D1 — RESOLVED:** New dedicated `discovery-gate` handler (keeps `file-context`'s file-path logic clean; the discovery gate derives its query from `pattern`/`query` via `buildPreToolQuery`).
- **D2 — RESOLVED:** Discovery gate defaults **OFF**. `CLAUDE_MEM_GATE_TOOLS` default empty → `shouldGateTool` returns false for everything → the hook fires but no-ops. Users opt in by setting the var. Safest for an active-on-install change.
- **D3 — RESOLVED (verified against Claude Code hook docs):**
  - **PreToolUse** supports `Grep`/`Glob`/`WebSearch` matchers, `tool_input` in payload, and `additionalContext` injection (**max 10,000 chars** — the injection builder must cap output). Capability 1 fully supported.
  - **SubagentStart** exists and supports `additionalContext`, BUT its payload carries only `agent_type`/`agent_id`/`session_id`/`cwd`/`permission_mode` — **NOT the task prompt**. So Capability 3 can only query by `agent_type` or fall back to the parent project's recent memory; it CANNOT be task-scoped. **Decision:** build Capability 3 with the project-recent-memory fallback, clearly labeled as coarse/project-level (not task-scoped), since task text is unavailable. This is honest: the subagent starts memory-aware at the project level.

## Additional constraint from D3
The injection block MUST be capped at ~10,000 chars (Claude Code's PreToolUse `additionalContext` limit). `buildInjectionBlock`/`positionForInjection` already cap by item count (default 5); add a hard character cap as defense.

## Scope / sequencing
Build in risk order: Capability 1 → 2 → 3, each its own reviewed task. Capability 3 is conditional on D3. This is a mini-sprint (≈4-6 TDD tasks), not a single change.
