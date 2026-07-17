# Record-Intent Tool Interceptor — Design

**Status:** Design (2026-07-16). Closes the tool-selection gap that the strengthened directive failed to close (measured 1/6). Next: implementation plan.

---

## Motivation & the gap this closes

The record-intent feature guarantees that a user-directed note is stored as a *findable user note* (`kind='user_note'`, `metadata.userDirected=true`) — findable via the `userDirected` search filter and the dashboard Notes panel. Two prior fixes landed:
- The **enforced write path** (`buildUserNoteRequest` + `note_add` MCP tool) made *tagging* deterministic: any `note_add` call lands correctly. Proven 100%.
- But *tool selection* is still the agent's choice. Validation (fresh session, 6-item battery) showed a fresh agent chose `note_add` only **1–2 of 6** times. The leak is phrasing-driven and robust: declarative record phrasings — "Remember that X", "Log that X", "note for later that X", "keep in mind that X" — get read as "capture fact X" and routed to the generic `observation_add`, which does **not** tag the row as a user note. Those notes go dark to the Notes panel / userDirected search.

A **strengthened directive experiment** (commit 7677c4c9: named `note_add` as the only correct tool, explicitly warned against `observation_add`, gave routing examples for both imperative and declarative phrasings, quoting the exact leaked phrasings) was re-measured with the identical battery and scored **1/6 — no improvement**. Conclusion: tool selection cannot be fixed with a directive. A stronger suggestion is still a suggestion. This must be **machinery**.

**Verified capability** (official Claude Code docs, code.claude.com/docs/en/hooks): a `PreToolUse` hook can match MCP tools by full name and can **rewrite the tool's arguments in-flight** via `hookSpecificOutput.updatedInput` ("updatedInput directly under hookSpecificOutput replaces a tool's arguments before it runs"). It cannot swap which tool runs — but rewriting arguments is enough: we make the `observation_add` call itself land as a user note.

## The fix, in one sentence

A `PreToolUse` interceptor that, when the current turn is a record-intent turn, rewrites any `observation_add` call's arguments in-flight to force `kind='user_note'` + `metadata.userDirected=true` — deterministic, invisible to the agent, no dependence on the agent choosing the right tool.

## Scope

**In:**
- A shared deterministic detector `isRecordIntent(prompt)`.
- Extend the existing `recordIntentHandler` (UserPromptSubmit) to stash a per-session `{promptId, armed, ts}` record-armed file.
- A new `PreToolUse` interceptor handler matching `mcp__plugin_memsmith_mem__observation_add` that reads the stash and, when armed, returns `updatedInput` forcing the user-note tags (merging existing metadata).
- `hooks.json` entry for the interceptor.
- Fail-open everywhere; never deny; never block a prompt.
- Live acceptance: re-run the 6-item battery; target 6/6 record items land as findable user notes regardless of which tool the agent picked.

**Out (explicitly):**
- Swapping the tool (impossible via hooks; unnecessary — rewriting args achieves the outcome).
- Changing `note_add` or `buildUserNoteRequest` (already correct).
- Changing the Layer-2 server backstop (writes via the server, not an MCP call — no PreToolUse fires; already tagged correctly).
- LLM-based detection at the hook layer (the deterministic keyword detector is enough and cheap; the backstop keeps its LLM path).
- Active stash garbage collection (best-effort; overwrite-per-prompt makes stale files harmless).

## Global Constraints

- **Fail-open, always.** The interceptor MUST NOT deny and MUST NOT block. Any error (missing/malformed stash, missing tool_input, read failure) → allow the call unchanged. A broken interceptor must never break `observation_add` or the prompt.
- **Deterministic detection.** `isRecordIntent` is a pure keyword/pattern match on the prompt — no LLM, no network.
- **Enforcement parity.** The rewrite forces the same tags as `buildUserNoteRequest`: `kind='user_note'`, `metadata.userDirected=true`, merging any existing metadata (userDirected set LAST).
- **Turn-scoped arming.** `armed` is computed once per prompt (UserPromptSubmit) and read per tool call (PreToolUse). Known limitation: an unrelated `observation_add` in the same turn as a record request will also be re-tagged (accepted — mis-tagging toward user_note is far less harmful than a wanted note going dark).
- **Session isolation.** The stash is keyed by `session_id` (from hook stdin), so sub-agents arm their own stash.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never commit to main:** dedicated branch. Nothing pushed.

---

## Architecture & Components

Two cooperating hooks sharing a tiny per-session file.

```
 UserPromptSubmit (existing recordIntentHandler, extended)
   • sees every prompt
   • armed = isRecordIntent(prompt)   (shared deterministic detector)
   • write ~/.memsmith/session/<session_id>.record-armed.json = {promptId, armed, ts}
        │
        ▼  (later in the same turn)
 PreToolUse  matcher: mcp__plugin_memsmith_mem__observation_add
   • read the stash for this session_id
   • if armed:
        return { hookSpecificOutput: { hookEventName:"PreToolUse",
          updatedInput: { ...tool_input, kind:"user_note",
            metadata: { ...(tool_input.metadata ?? {}), userDirected:true } } } }
   • else: emit nothing (allow unchanged)
        │
        ▼
   observation_add runs with rewritten args → row lands kind='user_note', userDirected=true
   → embed-on-write (already in /v1/memories) → findable via userDirected search + Notes panel
```

### Component 1 — `isRecordIntent(prompt)` (shared detector)
- **File (new):** `src/services/retrieval/record-intent-detect.ts`
- **Signature:** `export function isRecordIntent(prompt: string): boolean`
- **Behavior:** lowercases and pattern-matches the record verbs/phrasings — imperative AND declarative: `remember`, `record`, `log`, `park`, `mark`, `save`, `note` (as "note this"/"note for later"/"make a note"), `keep in mind`, `don't forget`. Matches when the phrasing directs the model to commit something to memory; excludes bare questions/commands. Pure; never throws.
- **Precision note:** deliberately biased toward recall (better to occasionally re-tag than to miss a note). The known turn-scope limitation already accepts over-tagging.

### Component 2 — UserPromptSubmit stash writer
- **File (modify):** `src/cli/handlers/record-intent.ts` (the existing `recordIntentHandler`)
- After reading the prompt and before/independent of the existing backstop call, compute `armed = isRecordIntent(prompt)` and write the stash file. Best-effort: wrap in try/catch → on any error, skip and continue. Preserve the existing always-CONTINUE contract and the existing backstop behavior (unchanged).
- **Stash path:** `~/.memsmith/session/<session_id>.record-armed.json`, content `{ "promptId": <string|null>, "armed": <boolean>, "ts": <number> }`. Create `~/.memsmith/session/` if missing.
- **session_id** comes from the hook stdin JSON (`session_id`). If absent, skip writing (interceptor then treats as not-armed).

### Component 3 — PreToolUse interceptor
- **File (new):** `src/cli/handlers/record-intent-intercept.ts` — an `EventHandler` for the PreToolUse event.
- **Behavior:** parse stdin `{ session_id, tool_name, tool_input }`. Read `~/.memsmith/session/<session_id>.record-armed.json`. If it exists, parses, and `armed === true`, AND `tool_input` is an object with a non-blank `content`, return:
  ```json
  { "hookSpecificOutput": { "hookEventName": "PreToolUse",
      "updatedInput": { ...tool_input, "kind": "user_note",
        "metadata": { ...(tool_input.metadata ?? {}), "userDirected": true } } } }
  ```
  Otherwise emit the neutral allow (`{ "continue": true, "suppressOutput": true }` or empty — matching the project's existing hook "no-op" output shape). Never returns a deny. Wrap everything in try/catch → on any error, emit the neutral allow.
- **Registration:** wire into the CLI hook dispatch (`src/cli/handlers/index.ts` or the equivalent registry the other handlers use) under a subcommand (e.g. `record-intent-intercept`).

### Component 4 — hooks.json entry
- **File (modify):** `plugin/hooks/hooks.json`
- Add a `PreToolUse` entry with `matcher: "mcp__plugin_memsmith_mem__observation_add"` invoking the interceptor subcommand. Scaffold byte-identical to the sibling PreToolUse entries (same command prefix/`server-service.cjs hook claude-code <subcommand>` shape).

---

## Data Flow & Edge Cases

| Situation | Behavior |
|---|---|
| Record turn → agent calls `observation_add` | Interceptor rewrites → row lands `user_note`/`userDirected`, embedded, findable. **The fix.** |
| Record turn → agent calls `note_add` | Interceptor doesn't match `note_add`; already correct. |
| Record turn + an UNRELATED `observation_add` same turn | Also re-tagged as user_note. **Known accepted limitation** (turn-scoped arming). |
| Non-record turn → `observation_add` | Stash `armed:false` → no rewrite → allow unchanged. |
| Backstop (Layer 2) write | Not an MCP call → no PreToolUse → unaffected (already tagged). |
| Sub-agent record turn | Own `session_id` → own stash → armed independently. |
| No stash / malformed / missing content | Not-armed path → allow unchanged. |

## Error Handling & Failure Modes

- Stash write fails (UserPromptSubmit) → skip, prompt CONTINUEs.
- Stash read fails / malformed JSON (PreToolUse) → treat as not-armed → allow unchanged.
- `tool_input` missing/malformed/blank `content` → allow unchanged (don't rewrite garbage).
- Interceptor throws anywhere → catch → allow unchanged.
- **Invariant:** the interceptor never denies, never blocks, never fails a call. Worst case it does nothing and the pre-fix behavior (agent's original tags) stands.

## Testing

**Unit:**
1. `isRecordIntent` — true for imperative (save this / park this / mark this) AND declarative (remember that / log that / note for later that / keep in mind that / don't forget that); false for questions ("what did we decide"), statements ("the build passes"), commands ("run the tests", "fix the bug", "open the dashboard").
2. Stash writer — armed prompt → `{armed:true}` written; non-record prompt → `{armed:false}`; write error → no throw, still CONTINUE.
3. Interceptor — armed stash + `observation_add` input → `updatedInput` forces `kind='user_note'` and `metadata.userDirected=true`, merges pre-existing metadata keys; not-armed → no output; missing stash → no output; missing/blank content → no output; malformed stash JSON → no output; NEVER returns deny.

**Live acceptance (re-run the battery that failed at 1/6):**
4. With the interceptor live (fresh session so MCP re-registers), run the identical 6-item record battery (mix of imperative + declarative phrasings). Verify ALL 6 resulting rows are `kind='user_note'`, `userDirected=true`, `embedding_vec NOT NULL`, and each is returned by a `userDirected:true` semantic search + shown in `/dashboard/notes`. Target: 6/6 (was 1/6).

## Acceptance Criteria

1. During a record-intent turn, an `observation_add` call lands `kind='user_note'` + `userDirected=true` + embedded — without the agent choosing `note_add`.
2. Detection is deterministic (`isRecordIntent`), covering the declarative phrasings that leaked.
3. The interceptor is fail-open: it never denies, never blocks, and on any error allows the call unchanged.
4. Non-record turns are unaffected; `note_add`, the backstop, and typed `observation_add` in non-record turns behave as before.
5. Live acceptance: the 6-item battery reaches 6/6 findable user notes (was 1/6).
6. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (separate specs)
- qwen Layer-2 classifier precision/compose-quality tuning.
- Narrowing the turn-scope over-tagging (per-call intent attribution) — only if it proves a real problem in practice.
- The other Tier-1 retrieval-first gaps.
