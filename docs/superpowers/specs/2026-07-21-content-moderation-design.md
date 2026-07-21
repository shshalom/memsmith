# Content Moderation — Design

**Status:** Design (2026-07-21). A standalone MemSmith feature (valuable in both `local` and `server`/team mode), independent of the Go Team wizard but complementary to it: with moderation in place, the wizard's convert-all becomes genuinely safe rather than a compromise. Sibling to the Go Team Wizard spec (`2026-07-21-go-team-wizard-design.md`); build order between the two is the user's call once both are written.

---

## Motivation

A user needs a way to keep content **out of memory** — either surgically (one sensitive fragment in an otherwise-normal session) or wholesale (a whole session that should leave no trace). Today MemSmith does neither cleanly, and there is a concrete leak.

**What already exists (verified against `main` @ `e384db4d`):**
- `src/utils/tag-stripping.ts` `stripTags()` / `stripMemoryTags()` already strips a fixed tag set — `'private'` is the **first** entry (alongside `memsmith-context`, `system_instruction`, `system-instruction`, `persisted-output`, `system-reminder`); `MAX_TAG_COUNT = 100`.
- The generation prompt-builder (`src/server/generation/providers/shared/prompt-builder.ts:122`) already runs `stripTags` on every agent-event payload **before** building the LLM prompt, tracking `hadPrivateContent` / `hadPrivate`. So `<private>` content **never reaches a generated observation** and **never reaches the LLM provider**.
- `summarize.ts:84` also strips.
- `session-init.ts` already short-circuits **injection** for private-flagged prompt inits.

**The gap this spec closes:** `src/server/services/IngestEventsService.ts` (`ingestOne` / `ingestBatch`) calls `eventsRepo.create(input)` storing the **raw event payload verbatim** in the `agent_events` table — **no strip at ingest**. The `<private>` strip only happens downstream at generation. So private content **is stored in plaintext in the raw `agent_events` table** even though it never becomes an observation.

- **Solo `local`:** low risk — it's your own local Postgres.
- **`server`/team mode:** a **genuine leak** — `agent_events` lives in the shared Postgres, so a teammate (or the wizard's Convert copy) could read raw private payloads.

This feature: (1) closes the ingest leak, and (2) adds a whole-session "record nothing" mode (incognito) on top of the surgical `<private>` tag.

## Scope

**In:**
- **`<private>…</private>` tags** — surgical redaction of a fragment. Rides the existing `stripTags` rail.
- **Incognito session** — a session/project-scoped mode that suppresses **all capture** (no events emitted, no observations generated) while **injection still works** (read yes, write no).
- **Defense-in-depth strip**: strip `<private>` at the **client PostToolUse hook** (before transmit — never leaves the machine) AND as a **server-side backstop** in `IngestEventsService` (covers any client/adapter).
- **Incognito controls**: `/incognito on` / `/incognito off` slash command (session/project-scoped); on-toggle confirmation; a "still incognito" heartbeat every ~N turns (default 10, settable) while ON.

**Out (explicitly):**
- A per-observation stored **"private" data-model flag** (marking an *already-stored* row private). This spec is capture-time only: private content is never stored. A stored-but-private model, if ever wanted, is its own spec and is the only thing that would add a predicate to the Go Team wizard's Convert filter (see the wizard spec's filter-F seam).
- Redaction/scrubbing of already-stored historical data.
- Per-tool skip lists (`CLAUDE_MEM_SKIP_TOOLS` equivalent) beyond what already exists.
- Any change to the injection/read path (incognito deliberately leaves injection intact).

## Global Constraints

- **Capture-time only.** Moderation prevents an observation/event from ever being **stored**. It never mutates already-stored rows. Nothing in this spec introduces a "stored but hidden" concept.
- **Fail-safe = suppress.** If it's ambiguous whether content is private or whether incognito is on, err toward **not capturing**. A missed capture is recoverable (redo it); a leaked secret is not.
- **Never break the read path.** Incognito suppresses writes only. Memory injection/recall continues to work in an incognito session.
- **The server strip is the definitive backstop.** The client hook is the primary protection (never-leaves-machine), but correctness of the leak-closure is proven at the server ingest chokepoint, which every client shares.
- **No local-mode regression.** Existing capture behavior is unchanged when no `<private>` tag is present and incognito is off. Existing tests stay green.
- **Reuse the existing rail.** Use `stripTags` / `stripMemoryTags` and the existing `IngestEventsService` chokepoint; do not build a parallel strip.
- **Visible state.** Incognito's dangerous failure is believing it is ON when it is OFF (or vice-versa). Toggle confirmation + the every-N heartbeat exist to prevent silent memory loss.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## Architecture

```
                        ┌─── <private> path (surgical) ───┐
capture event  ─────────┤                                  │
(PostToolUse hook)       │  1. CLIENT strip (hook):         │
      │                  │     stripTags(payload) before    │
      │                  │     POST /v1/events  ────────────┼──► never leaves machine
      ▼                  │                                   │
  incognito ON? ─ yes ──►│  emit NOTHING (no POST at all)    │
      │ no               │                                   │
      ▼                  │  2. SERVER backstop:              │
  POST /v1/events ───────┼──► IngestEventsService            │
                         │     stripTags(payload) BEFORE     │
                         │     eventsRepo.create()  ─────────┼──► agent_events has no <private>
                         └───────────────────────────────────┘
                                     │
                                     ▼  (unchanged)
                         generation prompt-builder stripTags  (existing 3rd layer)
                                     │
                                     ▼
                              observation (never had private)
```

Three strip layers total: client hook (new), server ingest (new — the leak closure), generation prompt-builder (already exists). Incognito is a per-session flag the client hook honors by not emitting.

## Components

### 1. Server-side ingest strip — modify (`src/server/services/IngestEventsService.ts`)
- Before `eventsRepo.create(input)` in both `ingestOne` and `ingestBatch`, run the event payload through `stripTags`. The stored payload carries no `<private>` content. This is the backstop that closes the leak for every client (including the compat adapter, which shares this service).
- Preserve existing behavior for payloads with no private tags (byte-identical after strip of a tag-free string, modulo the existing `.trim()`).

### 2. Client-side hook strip + incognito suppression — modify the capture hook path
- In the PostToolUse capture handler, strip `<private>` from `tool_input` / `tool_response` before constructing the `/v1/events` payload (private text never leaves the machine).
- If incognito is ON for the session, **do not emit** the event at all (short-circuit before the POST). Reuse the existing private-flag plumbing pattern from `session-init.ts`.

### 3. Incognito flag + toggle — new slash command + session flag
- `/incognito on` / `/incognito off` (and a bare `/incognito` toggle) sets a session/project-scoped flag the capture hook reads.
- Scope: from the moment of flip until flipped back or the session ends. Not persisted across sessions (a persistent project-wide setting is out of scope for this spec to avoid the "forgot it's on for weeks" failure).

### 4. Incognito feedback — confirmation + heartbeat
- **On toggle:** emit a clear confirmation (`🔒 Incognito ON — nothing from this session will be recorded` / `Incognito OFF — recording resumed`).
- **Heartbeat:** while incognito is ON, re-surface a short reminder (`🔒 still incognito — not recording`) every ~N turns. Default N = 10, overridable via a setting (e.g. `MEMSMITH_INCOGNITO_REMINDER_TURNS`). No reminder when OFF.

### 5. Config — settings registry
- `MEMSMITH_INCOGNITO_REMINDER_TURNS` (default `10`) in the settings registry + resolver getter, following the existing `MEMSMITH_IDENTITY_PROVIDER` pattern.

## Data Flow

- **Normal session, `<private>` fragment:** hook strips it before POST → server strips again (backstop) → `agent_events` never holds it → generation never sees it. Rest of the session captured normally.
- **Incognito session:** hook emits nothing → no events, no generation jobs, no observations. Injection/recall still served on request. Turning it off resumes normal capture.
- **Non-hook client (e.g. compat adapter) with `<private>`:** client strip may be absent, but the server ingest strip removes it before storage — leak still closed.

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| `<private>` present | Stripped at client (if hooked) and unconditionally at server ingest; never stored |
| Incognito ON | No events emitted; no observations; injection unaffected |
| Ambiguous / strip error | Fail-safe: suppress capture (don't store) rather than risk a leak; log a SYSTEM warning |
| Client bypasses hook | Server ingest strip still removes `<private>` (backstop) |
| User forgets incognito is ON | Every-N heartbeat re-surfaces the state; guards silent memory loss |
| `MAX_TAG_COUNT` exceeded | Existing `stripTags` warning path; still strips |

**Invariant:** private content is never persisted to `agent_events` or to any observation, via at least the server backstop, regardless of client.

## Testing

1. **Ingest strip (the regression that proves the leak is closed):** a raw event whose payload contains `<private>…</private>` → after `IngestEventsService.ingestOne`, the stored `agent_events` row's payload contains none of the private text. Same for `ingestBatch`.
2. **Tag-free unchanged:** a payload with no private tags stores as today (no behavioral regression).
3. **Client hook strip:** capture handler strips `<private>` before building the `/v1/events` payload.
4. **Incognito suppression:** with incognito ON, the capture hook emits zero events; no generation jobs created; injection/recall on request still returns results.
5. **Incognito toggle + confirmation:** `/incognito on|off` flips the flag and emits the confirmation copy.
6. **Heartbeat:** while ON, the reminder surfaces every N turns (default 10, honoring the setting) and is silent when OFF.
7. **Live acceptance:** dogfood — a `<private>` fragment never appears in `agent_events`; an incognito session leaves the observation store unchanged; a normal session after `/incognito off` records again.

## Acceptance Criteria

1. `<private>` content is stripped at the client hook (before transmit) AND unconditionally at `IngestEventsService` before storage; the raw `agent_events` table never holds private text (verified by test) — the team-mode leak is closed.
2. Incognito mode suppresses all capture (no events, no observations) while injection/recall still works.
3. `/incognito on|off` toggles session/project-scoped incognito with clear on-toggle confirmation.
4. A "still incognito" heartbeat surfaces every ~N turns (default 10, settable) while ON; silent when OFF.
5. No regression: tag-free / non-incognito capture behaves exactly as today; existing tests green.
6. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (own specs)
- Per-observation stored "private" flag (stored-but-hidden rows) — the only thing that would add a predicate to the Go Team wizard's Convert filter-F.
- Redaction of already-stored historical data.
- Persistent project-wide incognito setting (deliberately omitted here to avoid silent long-term memory loss).
