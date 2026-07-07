# Per-Prompt Hybrid Injection (Determinism 9A) — Design

**Grab-spec component:** #9A (Determinism layer — inject at session/action/**prompt**).
Reconciliation of the earlier "9A absent" finding: all three injection points
actually EXIST as live hooks —
- **session** → `SessionStart` → `context.ts` → `buildInjectionBlock` (hybrid RRF +
  L0–L3 tiering + positioning),
- **action** → `PreToolUse` → `discovery-gate.ts` → `buildInjectionBlock`,
- **per-prompt** → `UserPromptSubmit` → `session-init.ts` → `/api/context/semantic`.

The real gap is **inconsistency**: per-prompt injection routes through a separate
**worker-mode SQLite** endpoint (`/api/context/semantic`, SearchRoutes.ts) and so does
NOT get the hybrid ranking or the L0–L3 tiering the other two paths use. This design
unifies per-prompt injection onto the same server-mode hybrid+tiered path **when a team
server is configured**, leaving worker-only installs on their existing SQLite path
untouched.

## Problem

In a session backed by a team server, session/action injection use hybrid RRF +
tiering, but the per-prompt hook (`session-init.ts`) still calls the worker SQLite
`/api/context/semantic`. So the highest-signal injection moment — a fresh user prompt,
which is a far better query than the SessionStart project-name query — gets the weakest
retrieval. Per-prompt recall should be at least as good as session recall.

## Behavior (settled)

**When `MEMSMITH_TEAM_SERVER_URL` + `MEMSMITH_TEAM_API_KEY` are configured**, the
per-prompt hook fetches team memory via `fetchTeamMemory({ query: prompt })` (→ scoped
`/v1/search`, hybrid) and renders it through `buildInjectionBlock` (tiering +
positioning), exactly as SessionStart does — but with the **prompt text as the query**
(higher signal than SessionStart's project-name query).

**When no team server is configured** (worker-only install), behavior is UNCHANGED —
the existing `/api/context/semantic` path runs as today. This is the safe-by-default
guarantee: an install without a configured team server sees zero behavior change.

Composition: reuses `buildInjectionBlock`, so per-prompt injection automatically
inherits the private-filter, the `MEMSMITH_TIERING` off-switch, positioning, and the
`maxChars` budget already built.

## Architecture

Single change site: `src/cli/handlers/session-init.ts`, the `UserPromptSubmit` handler
(~lines 147-160), where `additionalContext` is currently built from
`/api/context/semantic`.

Add a **server-mode branch that runs first**:

```
if (semanticInject && prompt is injectable) {
  if (teamServerConfigured(settings)) {
    // NEW: hybrid + tiered, query = the actual prompt
    const rows = await fetchTeamMemory({
      serverUrl: settings.MEMSMITH_TEAM_SERVER_URL, apiKey: settings.MEMSMITH_TEAM_API_KEY,
      projectId: project, teamId: '', query: prompt,
    });
    const block = await buildInjectionBlock({ hybridSearch: async () => rows },
      { projectId: project, teamId: '', query: prompt });
    if (block) additionalContext = block;   // fetchTeamMemory returns [] on any error → empty block → fall through
  }
  if (!additionalContext) {
    // UNCHANGED existing worker SQLite semantic path
    ...executeWithWorkerFallback('/api/context/semantic', ...)
  }
}
```

`teamServerConfigured(settings)` = both `MEMSMITH_TEAM_SERVER_URL` and
`MEMSMITH_TEAM_API_KEY` present and non-empty (a helper, mirroring the SessionStart
gating). Prompt injectability gate (`prompt.length >= 20`, not `[media prompt]`) is
kept as-is.

The SessionStart injection block is the exact pattern to mirror (context.ts:161-173).
`fetchTeamMemory` never throws (returns [] on any error), and `buildInjectionBlock`
returns '' on empty — so a configured-but-unreachable server yields an empty block and
falls through to the worker path; injection never breaks the prompt hook.

## Data flow

`UserPromptSubmit` → session-init handler → [team server configured?]
  → yes: `fetchTeamMemory(query=prompt)` → `buildInjectionBlock` → hybrid+tiered block
  → no / empty: existing `/api/context/semantic` worker block
→ `hookSpecificOutput.additionalContext` (unchanged shape).

## Scope / non-goals (YAGNI)

- **In scope:** the per-prompt (`UserPromptSubmit`) injection path only.
- **Not touched:** SessionStart and PreToolUse (already on the hybrid path); the worker
  `/api/context/semantic` endpoint (still the fallback); the schema; the hook wiring
  (`hooks.json`) — this is a handler-internal routing change, no new hook.
- **Not in scope:** spawn/subagent injection (FR-1, upstream-blocked).
- No new env flag — reuses `MEMSMITH_TEAM_SERVER_URL`/`_API_KEY` (the same gate
  SessionStart uses) and `MEMSMITH_SEMANTIC_INJECT` / `MEMSMITH_TIERING`.

## Error handling

- `fetchTeamMemory` swallows all errors → []; empty rows → `buildInjectionBlock` → ''
  → falls through to the worker path. A configured-but-down server degrades to the
  existing behavior, never an empty injection where the worker could have served one.
- The whole server branch is wrapped so any unexpected throw logs and falls through to
  the worker path (same posture as SessionStart's try/catch).
- Prompt-hook must never break prompt submission: on total failure, return the
  no-injection result (`continue: true`), exactly as today.

## Testing

Handler-level tests (mock `fetchTeamMemory` / worker fetch; no live server):

1. **Server-configured → hybrid path used** — with team URL+key set and a ≥20-char
   prompt, the handler calls `fetchTeamMemory` with `query === prompt` (not project)
   and returns its `buildInjectionBlock` output as `additionalContext`.
2. **Server not configured → worker path unchanged** — no team URL: `fetchTeamMemory`
   is NOT called; the existing `/api/context/semantic` result is returned (regression
   guard on today's behavior).
3. **Server configured but returns [] (down/empty) → falls through to worker** —
   `fetchTeamMemory` → []; handler still produces the worker semantic block, not empty.
4. **Query is the prompt, not the project** — explicit assert that the server-mode
   query is the user prompt text (the signal improvement).
5. **Injectability gate preserved** — a <20-char prompt or `[media prompt]` injects
   nothing on either path.
6. **Never breaks the hook** — a thrown error in the server branch is caught; handler
   returns a valid `continue: true` result (falls through / no injection), never
   propagates.
7. **Private filter + tiering inherited** — because the server path uses
   `buildInjectionBlock`, a private row is excluded and `MEMSMITH_TIERING=0` restores
   whole-item behavior (light assertion that the shared builder is actually the code
   path, e.g. header string matches `buildInjectionBlock`'s).
