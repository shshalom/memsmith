# Enforced User-Note Write Path (Layer-1 tagging fix) — Design

**Status:** Design (2026-07-16). Fixes the Validation-#2 critical gap found while validating the `record-intent` feature before merge. Next: implementation plan.

---

## Motivation & the gap this closes

The deterministic record-intent feature (branch `record-intent`, merge-ready plumbing) has two detection layers:
- **Layer 1 (agent):** a `RECORD_INTENT_DIRECTIVE` tells the agent to compose a self-contained note and record it. The agent writes via the generic `observation_add` MCP tool.
- **Layer 2 (server backstop):** `POST /v1/record-intent` classifies the user prompt via the local Ollama provider and writes the note.

Live validation (2026-07-16) proved the plumbing sound — idempotency, embed-on-write, the `userDirected` search filter, semantic recall, fail-open, and the no-file guarantee all PASS. But **Validation #2 (end-to-end via a real agent)** exposed a critical behavioral defect on the **primary path**:

A fresh subagent, given natural record requests, recorded exactly the right things and self-reported success — but the notes landed as `kind='manual'` with `metadata.userDirected=null`, **not** `kind='user_note'` + `metadata.userDirected=true` as the directive requires. **Consequence:** the notes are in memory and embedded, but **invisible to the `userDirected:true` search filter and the dashboard Notes panel** — defeating the retrieval half of the feature on the path users actually use.

**Root cause:** the `observation_add` MCP tool (`src/servers/mcp-server.ts:389`) defaults `kind` to `'manual'` and only forwards `kind`/`metadata` when the caller supplies them (`:161-162`). The entire burden of tagging a user note falls on the agent passing two params correctly — and the agent silently omitted them while still believing it succeeded. That is a suggestion, not machinery.

**Validation #3 (recall round-trip)** made the cost concrete: a correctly-tagged note recalls semantically end-to-end, but the agent's *accurate* mis-tagged note did **not** surface under the `userDirected` filter, while a *wrong* qwen-composed backstop note did. So the gap changes **which note a user retrieves** — it is not cosmetic.

## The fix, in one sentence

Make user-note tagging **structurally impossible to get wrong**: a dedicated MCP write tool that takes only `content` and hard-codes the tags, backed by one shared enforcer that both detection layers write through.

## Scope

**In:**
- A pure shared enforcer `buildUserNoteRequest` that sets `kind='user_note'` and `metadata.userDirected=true` as the *last* word, overriding any caller-supplied values.
- A new MCP tool (`note_add`) that takes only `content` (+ optional `projectId`) — no `kind`/`metadata` param to omit or mis-set — and writes via the enforcer.
- Route the existing `/v1/record-intent` backstop write through the same enforcer (it already tags correctly; this unifies the source of truth so the two layers can't drift).
- Update `RECORD_INTENT_DIRECTIVE` to instruct the agent to call `note_add` with the composed content (no params to specify).
- Move the dashboard Notes panel above the Decisions panel (`DashboardView.tsx`) — bundled UI request.
- Re-run Validations #2 and #3 as live acceptance.

**Out (explicitly):**
- **qwen Layer-2 precision / compose-quality.** Validation #1 found the Ollama backstop is too eager (3 false positives on 8 negatives) and sometimes composes garbled/wrong notes. This is model-bound (prompt-tuning with its own live re-test loop, no binary pass/fail) and is a **separate follow-up spec**. Mixing it with this deterministic code fix is a scope smell.
- Changing `observation_add` — it stays generic and untouched; it is still correct for typed observations.
- Changing the idempotency, embed-on-write, filter, or fail-open machinery (all validated PASS).
- Cross-layer dedup between the agent note and the backstop note (documented known limitation of `record-intent`, unchanged here).

## Global Constraints

- **Tags are enforced, not requested.** `buildUserNoteRequest` sets `kind='user_note'` and `metadata.userDirected=true` LAST; a caller passing `kind:'manual'` or `userDirected:false` MUST be overridden. This is the whole point — verified by test.
- **The new tool exposes no tag params.** `note_add` takes `content` (required) and `projectId` (optional) only. No `kind`, `metadata`, or `userDirected` parameter exists on it.
- **Detection is unchanged.** This spec touches only the WRITE path. What phrasing counts as record intent (any natural phrasing) remains the agent's/backstop's job — do not narrow it to a keyword.
- **One behavior, one place.** Exactly one enforcer sets the tags; both the new tool and the backstop write through it. No duplicated tag literals.
- **No-file guarantee preserved.** No record/note path may write to a file. The new tool has zero file-write code.
- **Fail-open preserved.** The backstop's UserPromptSubmit contract (never block the prompt) is unchanged; the enforcer is pure and cannot throw on valid input.
- **Embed-on-write preserved.** Both paths still embed on write (`embedForPersist`) — the enforcer only sets tags; it does not touch the embed step.
- **Commit trailer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never commit to main:** work on a dedicated branch. Nothing pushed.

---

## Architecture & Components

One shared enforcer, two callers.

```
  NEW MCP tool  note_add(content, projectId?)  ─┐
  (agent, Layer 1)                              │
                                                ├─▶ buildUserNoteRequest(content, {projectId, idempotencyKey?, metadata?})
  /v1/record-intent write closure  ─────────────┘        • kind = 'user_note'            (forced, last)
  (backstop, Layer 2)                                    • metadata.userDirected = true  (forced, merged last)
                                                                        │
                                                                        ▼
                                             ServerAddObservationRequest → client.addObservation
                                                     → POST /v1/memories → embedForPersist → row
                                                     (kind='user_note', userDirected=true, embedding_vec NOT NULL)
```

### Component 1 — `buildUserNoteRequest` (shared enforcer)
- **File (new):** `src/services/retrieval/user-note-write.ts`
- **Signature:** `buildUserNoteRequest(content: string, opts: { projectId: string; idempotencyKey?: string; metadata?: Record<string, unknown> }): ServerAddObservationRequest`
- **Behavior:** builds the request object; sets `kind: 'user_note'` and `metadata: { ...opts.metadata, userDirected: true }` LAST so any caller-provided `kind`/`userDirected` is overridden. Forwards `content`, `projectId`, and `idempotencyKey` (when present). Pure; no I/O; never throws on a string input.
- **Rationale for a new file:** persistence-policy helper, parallel to `embedForPersist` (`src/server/generation/embed-for-persist.ts`). Keeps the MCP server and route thin. `ServerAddObservationRequest` is imported from its existing definition (`src/services/hooks/server-client.ts`).

### Component 2 — `note_add` MCP tool
- **File (modify):** `src/servers/mcp-server.ts`
- **Args interface:** `interface NoteAddArgs { projectId?: string; content: string }` — deliberately no `kind`/`metadata`/`idempotencyKey`.
- **Handler `handleNoteAdd`** (mirrors `handleObservationAdd:151-167`): `requireServerForObservationTool('note_add')`; validate non-blank `content` (throw `'note_add: "content" is required'` on blank, matching `observation_add`'s message shape); resolve `projectId = args.projectId?.trim() || ctx.projectId`; `const request = buildUserNoteRequest(args.content, { projectId })`; `const response = await ctx.client.addObservation(request)`; `return formatJsonResult(response)`.
- **Registration:** add to the `tools[]` array adjacent to the `observation_add` entry (~`:389`) with `name: 'note_add'`, an `inputSchema` exposing only `content` (required) + `projectId` (optional), and `handler: async (args: any) => handleNoteAdd(args ?? {})`.
- **Description (verbatim intent):** "Record a user-directed note to memory. Use this whenever the user asks to record / remember / note / save / park / log something, in any phrasing. Hard-tags the note as a findable user note (kind=user_note, userDirected). Server runtime only. Params: content (required), projectId (optional, falls back to settings)."

### Component 3 — Backstop routes through the enforcer
- **Files (modify):** `src/server/routes/v1/record-intent.ts`, `src/server/routes/v1/ServerV1PostgresRoutes.ts`
- The `/v1/record-intent` write closure currently sets `content`, `metadata:{userDirected:true}`, `kind:'user_note'`, `idempotencyKey` inline and computes `embeddingVec = await embedForPersist(o.content)` before `repo.create`. Replace the inline `kind`/`metadata` literals by building the persisted values from `buildUserNoteRequest(content, { projectId, idempotencyKey, metadata })`, then create with the embed step unchanged. Net behavior byte-identical (same tags, same embed, same key); the tags now come from the single enforcer.

### Component 4 — Directive
- **File (modify):** `src/services/retrieval/directive.ts`
- Change `RECORD_INTENT_DIRECTIVE`: instead of "call `observation_add` with kind:'user_note' and metadata.userDirected:true", instruct "call the `note_add` tool with the composed self-contained note as `content`". Keep the compose-self-contained, confirm-echo ("📝 Recorded to memory: …"), surface-on-failure, and no-files language. The directive is injected at both existing sites (`context.ts` SessionStart, `agent-directive.ts` PreToolUse:Agent) via `INJECTED_DIRECTIVES` — no change to injection wiring.

### Component 5 — Dashboard UI
- **File (modify):** `src/server/dashboard/DashboardView.tsx`
- Move the Notes panel above the Decisions panel in render order. No data/fetch change (both already wired: `fetchDashboard('notes')` / `GET /dashboard/notes`).

---

## Data Flow (fixed Layer-1 path)

```
user: "park this idea…"  (any phrasing — detection unchanged)
  → agent recognizes record intent (directive)
  → agent composes a self-contained note, calls note_add({ content })
  → handleNoteAdd: validate → buildUserNoteRequest(content, { projectId })
       → { kind:'user_note', metadata:{ userDirected:true }, content, projectId }
  → client.addObservation → POST /v1/memories → embedForPersist → row lands
       kind='user_note', userDirected=true, embedding_vec NOT NULL
  → agent echoes "📝 Recorded to memory: <summary>"
```

The row is now visible to the `userDirected:true` filter and the dashboard Notes panel — the exact outcome Validation #2/#3 showed was missing.

## Error Handling & Failure Modes

| Failure | Behavior |
|---|---|
| Blank/whitespace content to `note_add` | Handler throws `note_add: "content" is required` (same shape as `observation_add`); surfaces to the agent, which reports the failure per directive. No row written. |
| `client.addObservation` fails (HTTP/network) | Propagates as a tool error; agent surfaces "⚠ Couldn't record to memory". No file fallback (no-file guarantee). |
| Backstop path error | Unchanged fail-open contract: `/v1/record-intent` returns `{recorded:false}` (never 500); the CLI hook always CONTINUEs. The pure enforcer cannot throw on valid input. |
| Caller passes `kind:'manual'` / `userDirected:false` to the enforcer | Overridden — enforcer sets `user_note`/`true` last. (This is the guarantee, asserted by test.) |

## Testing

**Unit:**
1. `buildUserNoteRequest` forces `kind='user_note'` even when `opts.metadata` or a caller kind says otherwise; forces `metadata.userDirected=true` even when caller passes `userDirected:false`; merges other metadata keys; preserves `content`, `projectId`, `idempotencyKey`.
2. `handleNoteAdd`: blank content throws; valid content produces a request carrying the forced tags (assert against a stubbed `client.addObservation` capturing its argument).

**Regression / integration:**
3. Backstop parity — `/v1/record-intent` still writes `kind='user_note'` + `userDirected:true` (now via the enforcer) and still embeds (`embedding_vec NOT NULL`). (pg-gated live test.)
4. Directive — `RECORD_INTENT_DIRECTIVE` names `note_add` and no longer instructs manual `kind`/`metadata` params.

**Live acceptance (re-run Validations #2 and #3):**
5. Dispatch a fresh E2E subagent with natural record prompts → verify the rows land `kind='user_note'`, `userDirected=true`, `embedding_vec NOT NULL` (Validation #2 now PASSES where it failed).
6. Recall — a later differently-worded `userDirected:true` query surfaces the agent-composed note; the dashboard `/dashboard/notes` shows it (Validation #3).

**UI:**
7. Dashboard renders the Notes panel before the Decisions panel.

## Acceptance Criteria

1. A note recorded through `note_add` (or the backstop) lands with `kind='user_note'`, `metadata.userDirected=true`, and a non-null `embedding_vec` — with the agent passing **no** tag parameters.
2. The enforcer overrides any caller-supplied `kind`/`userDirected` — verified by test.
3. Exactly one shared enforcer sets the tags; both the new tool and the backstop use it; no duplicated tag literals.
4. `observation_add` is unchanged; detection phrasing is unchanged; fail-open and no-file guarantees hold.
5. Re-run Validation #2 PASSES (E2E agent notes are `user_note`/`userDirected`) and Validation #3 PASSES (recall surfaces the agent's note).
6. Dashboard Notes panel renders above Decisions.
7. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (separate specs)
- qwen Layer-2 classifier precision (false positives) + compose-quality (garbled/wrong notes) — prompt-tuning, needs its own live re-test.
- The other Tier-1 retrieval-first gaps (hard-mode narrow scoping, sub-agent coverage, behavioral validation).
