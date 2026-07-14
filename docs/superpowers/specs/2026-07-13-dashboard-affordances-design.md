# MemSmith Dashboard Affordances — Design

**Goal:** Make the MemSmith dashboard easy to reach — surface its URL in the SessionStart context injection, and add an `/ms-dashboard` skill that opens it.

## Scope

Two plugin-native affordances (both verified feasible):
1. **Dashboard URL line in the SessionStart injection** — appears at session start, even on an empty/new project.
2. **`/ms-dashboard` skill** — resolves the dashboard URL and presents/opens it.

**Explicitly NOT built (verified impossible):** a button on Claude Code's `/plugin` page. That screen is Claude Code's own built-in UI; the plugin manifest (`plugin.json`) has no extension point for custom row actions. The skill is the plugin-native substitute for a "button."

## URL derivation (shared)

The dashboard/viewer is served by the local server on a UID-derived port. Today the port logic lives in a **private** `getServerPort()` in `ServerService.ts:865`:
```
MEMSMITH_SERVER_PORT (if set, integer > 0), else 38877 + (uid % 100)
```
This spec adds a small **exported** helper so both the injection line and the skill derive the URL identically instead of reaching into a private function or hardcoding a port.

- New export `resolveDashboardUrl(): string` in a shared module (e.g. `src/shared/dashboard-url.ts`):
  - port = `parseInt(MEMSMITH_SERVER_PORT)` if a positive integer, else `38877 + (process.getuid?.() ?? 77) % 100`.
  - returns `http://127.0.0.1:<port>`.
  - Pure, no I/O, never throws.
- `ServerService.ts`'s existing `getServerPort()` may optionally delegate to this to keep one source of truth, but that refactor is not required by this spec (leave it if risky).

## Component 1 — SessionStart injection line

`src/cli/handlers/context.ts` assembles the injected string (`additionalContext`) and already has a **prepend-a-hint** pattern (the stale-OAuth marker: `` `${hint}\n\n${additionalContext}` ``). The dashboard line uses the same pattern.

- After `additionalContext` is resolved (and after the stale-OAuth hint handling), prepend a single line:
  `📊 MemSmith dashboard: <resolveDashboardUrl()>`
- Because it lives in the handler (not inside `buildInjectionBlock`, which returns `''` on empty memory), the link shows **always** — including on a brand-new project with no observations yet. This is the case where a dashboard link is most useful.
- Graceful: `resolveDashboardUrl()` never throws; if for any reason the URL is empty, omit the line. Never break injection.
- Keep it one line; do not duplicate if `additionalContext` already contains it (it won't — this is the only injector of it).

## Component 2 — `/ms-dashboard` skill

MemSmith ships **skills, not slash-commands** (no `plugin/commands/` dir; 17 `ms-`-prefixed skills). Add an 18th:

- `plugin/skills/ms-dashboard/SKILL.md` with frontmatter `name: ms-dashboard` and a description like "Open the MemSmith dashboard (memory viewer + metrics) in the browser."
- Behavior instructed in the skill body: resolve the dashboard URL (same derivation — the skill can compute `38877 + uid%100` or read `MEMSMITH_SERVER_PORT`), present it as a clickable link, and offer to launch it (`open <url>` on macOS; print the URL on other platforms).
- Fits the existing `ms-` namespace (the separation work's guard test asserts every skill is `ms-`-prefixed — this one complies).

## Data flow

No new services or state. Both components are read-only URL surfacing:
- session start → context.ts → prepend `resolveDashboardUrl()` line → injected string.
- user types `/ms-dashboard` → skill resolves URL → shows/opens it.

## Error handling

- `resolveDashboardUrl()` is pure and total (uid fallback `77`); cannot throw.
- If the server isn't running, the URL still renders but won't load in the browser — acceptable (the user knows to start a session; a stopped server is a separate concern). The skill may note "start a MemSmith session if the page doesn't load."

## Testing

- **`resolveDashboardUrl()`**: returns `http://127.0.0.1:<38877+uid%100>` with no env; honors `MEMSMITH_SERVER_PORT` when set to a positive integer; ignores a non-integer/empty `MEMSMITH_SERVER_PORT` (falls back to uid-derived).
- **context.ts injection**: the injected `additionalContext` contains the `📊 MemSmith dashboard:` line AND the resolved URL — asserted both when memory is non-empty and when `buildInjectionBlock` would return `''` (empty project). Reuse the existing context.ts test harness / dependency injection.
- **Skill**: namespace guard (the existing `skill-namespace-separation.test.ts`) must still pass with 18 skills, all `ms-`-prefixed and frontmatter matching dir.
- tsc clean; full suite no new failures beyond the known pre-existing baseline.

## Acceptance criteria

1. A SessionStart injection (even on an empty project) contains `📊 MemSmith dashboard: http://127.0.0.1:<port>` with the correct UID-derived (or env-overridden) port.
2. `resolveDashboardUrl()` is a single shared source of the URL, used by both the injection and (equivalently) the skill; no hardcoded port literal in the injection path.
3. `/ms-dashboard` is a registered `ms-`-prefixed skill that surfaces + opens the dashboard URL; the namespace guard test passes at 18 skills.
4. No button is added to Claude Code's `/plugin` page (out of scope, impossible).
5. tsc clean; injection never breaks when URL resolution or memory is empty.
