# Moderation-Completeness — Design

**Status:** Design (2026-07-21). Follow-up to Content Moderation (`2026-07-21-content-moderation-design.md`), which closed the `<private>` leak for `agent_events` but explicitly left two pre-existing raw-prompt sinks out of scope. This makes the moderation invariant — "private content is never persisted / never reaches the LLM" — literally true across all write paths.

---

## Motivation

Content Moderation v1 strips `<private>…</private>` at three layers for the **agent-event** capture path (client hook, server `IngestEventsService` backstop, generation prompt-builder). But a final whole-branch review found two **pre-existing** write paths (not introduced by v1) that persist the raw user prompt **unstripped**, verified on `main` @ `680f0655`:

1. **`POST /v1/sessions/start`** (`ServerV1PostgresRoutes.ts` ~line 807) stores `metadata: (body.metadata ?? {})` verbatim into `server_sessions.metadata`. The client `session-init.ts` (~line 167) sends `metadata: { project, prompt }` — so the raw user prompt lands in `server_sessions`.
2. **`POST /v1/record-intent`** (`ServerV1PostgresRoutes.ts` ~line 997 → `record-intent.ts`) passes `body.prompt` unstripped to **three sinks**: the LLM classifier (`deps.complete(SYSTEM, prompt)`), the idempotency hash (`computeContentIdempotencyKey({… content: prompt})`), and (via the composed note) the stored observation.

Neither route imports any tag-stripping. For solo `local` this is low-risk (own DB); in `server`/team mode it is a genuine leak (shared Postgres) and it makes v1's stated invariant false. This spec closes both.

## Scope

**In:**
- Strip `<private>` at **`/v1/sessions/start`** — client (`session-init.ts` before it sends `metadata.prompt`) + server backstop (before the `server_sessions` write).
- Strip `<private>` at **`/v1/record-intent`** — client (`record-intent.ts` before it POSTs the prompt) + server backstop (once at the route boundary, before `classifyAndComposeRecordIntent`, so the stripped prompt feeds all three sinks).
- Reuse the existing rail: `stripMemoryTags` (`src/utils/tag-stripping.ts`) and/or `scrubEventPayload` (`src/server/services/event-payload-scrub.ts`).

**Out (explicitly):**
- Any new privacy model, schema change, or stored-private flag.
- Incognito changes (v1 already covers session capture suppression).
- Any path other than these two (v1 covers `agent_events`; the generation strip is unchanged).
- Redaction of already-stored historical `server_sessions.metadata` / notes.

## Global Constraints

- **Capture-time only.** Strip prevents a prompt (or its private fragments) from being **persisted** or **sent to the LLM**; never mutates already-stored rows.
- **Defense-in-depth (mirrors v1).** Strip at BOTH the client sender (never-leaves-machine) AND the server route (covers any client). The server strip is the definitive backstop.
- **`<private>` means "never persist," even inside a deliberate save.** In `/v1/record-intent` (the explicit "remember this" path), a `<private>` fragment is still stripped — recording the rest of the note without the secret. The classifier, the hash, and the stored content all see the stripped prompt.
- **Never reaches the LLM.** The record-intent strip happens BEFORE `deps.complete(...)`, so private content is never sent to the generation provider — same guarantee as v1's prompt-builder strip.
- **Fail-safe = suppress.** The strip helper is pure and never throws (same helper as v1); a tag-free prompt is byte-identical after strip (modulo the existing `.trim()`).
- **No regression.** Prompts with no `<private>` behave exactly as today; existing sessions/record-intent tests stay green.
- **Reuse, don't rebuild.** Use `stripMemoryTags`/`scrubEventPayload`; add no parallel stripper.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## Architecture

```
sessions/start:
  session-init.ts: prompt → stripMemoryTags → metadata:{project, prompt'}  ──POST──▶
     /v1/sessions/start: scrubEventPayload(body.metadata) ──▶ server_sessions.metadata  (no <private>)

record-intent:
  record-intent.ts (client): prompt → stripMemoryTags ──POST {prompt'}──▶
     /v1/record-intent: stripMemoryTags(body.prompt) ONCE at boundary ─┬─▶ LLM complete()      (no <private>)
                                                                        ├─▶ idempotency hash    (stripped)
                                                                        └─▶ stored note content (composed from stripped prompt)
```

Two strip layers per path: client sender (primary, never-leaves-machine) + server route (backstop, covers every client). Both reuse the v1 rail.

## Components

### 1. `/v1/sessions/start` server backstop — modify (`src/server/routes/v1/ServerV1PostgresRoutes.ts`, the `/v1/sessions/start` handler ~line 807)
- Before persisting, scrub the metadata object: `metadata: scrubEventPayload(body.metadata ?? {}) as Record<string, unknown>`. `scrubEventPayload` recursively strips `<private>` from every string value (so `metadata.prompt` and any other string field are covered). Preserves non-string values.

### 2. `session-init.ts` client strip — modify (`src/cli/handlers/session-init.ts`, `startServerSession` ~line 167)
- Strip the prompt before building the metadata: send `metadata: { project, prompt: stripMemoryTags(prompt) }`. Import `stripMemoryTags` from `../../utils/tag-stripping.js`.

### 3. `/v1/record-intent` server backstop — modify (`src/server/routes/v1/ServerV1PostgresRoutes.ts`, the `/v1/record-intent` handler ~line 997)
- Strip once at the boundary before classify: `const prompt = stripMemoryTags(body.prompt)`, then pass `prompt` to `classifyAndComposeRecordIntent(prompt, deps)`. Because `classifyAndComposeRecordIntent` already derives the LLM input, the idempotency key, and the stored content from its `prompt` argument, a single strip at the call site covers all three sinks. No change needed inside `record-intent.ts`'s `classifyAndComposeRecordIntent` beyond receiving the already-stripped prompt.

### 4. `record-intent.ts` client strip — modify (`src/cli/handlers/record-intent.ts` ~line 36)
- Strip before POST: `await runtime.client.recordIntent({ projectId: runtime.projectId, prompt: stripMemoryTags(prompt) })`.

## Data Flow

- **sessions/start:** client strips prompt → server scrubs metadata again → `server_sessions.metadata` holds no `<private>` content.
- **record-intent:** client strips prompt → server strips again at boundary → stripped prompt feeds LLM/hash/content → note recorded without the secret; nothing private reaches the provider or the DB.
- **Tag-free prompt:** unchanged (strip of a tag-free string is a no-op modulo trim).

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| `<private>` in a session prompt | Stripped at client + server; `server_sessions.metadata` never holds it |
| `<private>` in a record-intent prompt | Stripped once at boundary; never sent to LLM, never hashed, never stored |
| Tag-free prompt | Byte-identical behavior to today |
| Non-hook client posts raw `<private>` | Server backstop strips it before persist/LLM |
| Strip error | Cannot happen for string input (`stripMemoryTags` is pure/total); no throw on the path |

**Invariant (now literally true across all paths):** private content is never persisted to `agent_events`, `server_sessions`, or an observation, and never reaches the LLM provider — regardless of client.

## Testing

1. **sessions/start server:** a `/v1/sessions/start` body with `metadata.prompt` containing `<private>…</private>` → the persisted `server_sessions.metadata` contains none of the private text (assert at the DB-write boundary, mirroring the v1 ingest-strip test seam).
2. **session-init client:** `startServerSession` sends `metadata.prompt` with `<private>` stripped.
3. **record-intent server (the 3-sink test):** with a `<private>` fragment in the prompt, assert (a) the string passed to `deps.complete` contains none of the private text, (b) the idempotency-key input is stripped, (c) the stored content contains none of the private text. Use injected fakes for `complete`/`write` to capture what each sink receives.
4. **record-intent client:** the client handler strips before `client.recordIntent`.
5. **No regression:** a tag-free prompt yields today's behavior on both paths; existing sessions/record-intent tests green.
6. **Live acceptance:** dogfood — a `<private>` fragment in a real session prompt never appears in `server_sessions.metadata`; in a real "remember this: … `<private>secret</private>`" prompt, the recorded note excludes the secret and `server_sessions` is clean (query via the `pg` module, local role `memsmith` @ `:55433`).

## Acceptance Criteria

1. `<private>` content is stripped at BOTH the client sender and the server route for `/v1/sessions/start` and `/v1/record-intent`.
2. `server_sessions.metadata` never persists `<private>` content (verified by test).
3. In `/v1/record-intent`, the stripped prompt feeds all three sinks — the LLM classifier receives no private content, the idempotency hash is computed on the stripped prompt, and the stored note excludes the private fragment (verified by test).
4. No regression: tag-free prompts behave exactly as today; existing tests green.
5. The moderation invariant holds literally: no persist path (`agent_events`, `server_sessions`, observations) and no LLM path carries `<private>` content.
6. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (own specs)
- Redaction of already-stored historical `server_sessions.metadata` / notes (this spec is forward-only, capture-time).
- Any stored-but-private data model (still out of scope, as in v1).
