# Deterministic Record-Intent — Design

**Goal:** When the user expresses intent to save something to memory ("remember / record / log / park / mark this…", in natural language), MemSmith reliably writes it as a durable, embedded, **user-directed** observation — and makes that user-directed memory genuinely useful: filterable and boosted in search, and surfaced on the dashboard and in the observations view.

**Status:** Design approved section-by-section (2026-07-16). Next: implementation plan. One of the Tier-1 retrieval-first completeness gaps.

---

## Motivation & the gap this closes

MemSmith captures memory two ways: **passive** (the `PostToolUse` pipeline auto-records session activity) and **on-demand recall** (retrieval-first, already shipped). What's missing is the **write-side twin of retrieval-first**: when the user *explicitly* says "remember this," there is currently no enforced path that guarantees it lands in memory. The user must hope the agent chooses to call `observation_add` — the same "model discretion" weakness that hooks/MCP machinery were built to replace on the read side.

Two concrete failures motivated this (both surfaced live this session):
1. The user said "record this as an open thing"; the agent wrote it to a *file* (`docs/TODO.md`) instead of memory, and relied on passive capture — which lagged and wouldn't phrase it as a recallable note. **User principle established:** when the user says record/remember, it goes into MemSmith memory as a durable embedded observation — never a file unless explicitly asked.
2. When the agent *did* record via `observation_add`, the row came back with no embedding (semantically dark). That embed-on-write gap is now fixed (2026-07-16, `/v1/memories` embeds on write), which **unblocks this feature** — recorded notes are now immediately recallable.

User-directed memory is qualitatively different from ambient capture: it's the user's deliberate, first-person "remember this," and it's exactly the category passive capture structurally misses (e.g. founding intent, rationale the user holds in their head). Marking it and making search + the dashboard *use* the mark is the point — not dead metadata.

## Scope

**In (complete, end-to-end):**
- **Capture** — natural-language record-intent writes an observation marked user-directed (`kind: 'user_note'`, `metadata.userDirected: true`), embedded, with a **visible confirmation** so the capture is never silent.
- **Search — filter:** recall can isolate user-directed notes (a `userDirected` filter through `/v1/search`, `/v1/context`, and the repo, extending the existing `obsType`-filter seam).
- **Search — boost:** a post-ranking reorder transform (at the existing `resolveSearchResults` post-rank seam, alongside supersession) floats user-directed notes up **within already-relevant results**; strength is a **tunable setting** with a conservative default, mirroring the existing `ftsWeight`/`vecWeight`/`rrfK` knobs.
- **Dashboard** — a "Notes" panel (mirrors the Decision-log panel) AND a "My notes" filter chip in the Observations view (reuses the existing type/lifecycle chip UI).

**Out (explicitly):**
- Re-tuning the RRF fusion math itself (boost is a post-rank *reorder*, not a fusion-weight change).
- A blocking "record what?" prompt on ambiguous referents (we use compose-best-guess + visible confirmation + correct-after instead).
- Sub-agent record-intent (sub-agents get no `UserPromptSubmit`; the agent-side directive + `observation_add` still work if a sub-agent chooses to call it, but dedicated sub-agent capture is a separate concern).
- The other Tier-1 gaps (hard-mode scoping, sub-agent coverage verification, behavioral validation) — each its own spec.

## Global Constraints

- **Determinism where it can be, model-judgment where it must be.** The *understanding* of natural-language record-intent is the agent (an LLM reading with full context — the one thing only an LLM can do). The *rule* (a standing directive) and the *capture* (enforced embedded write) are MemSmith machinery. This mirrors retrieval-first exactly.
- **The directive lives in MemSmith code, NOT CLAUDE.md.** Memory-behavior rules are hook/MCP-delivered machinery; a CLAUDE.md suggestion regresses to model discretion (the removed Memory-First CLAUDE.md section is precedent).
- **Write failures are LOUD; read failures are QUIET (fail-open).** A requested save that fails must be surfaced to the user (they asked). A boost/filter error degrades silently to normal recall (invisible-and-fine).
- **The user-directed mark is first-class and MUST survive ranking into result rows** (`kind`/`metadata` present on results) — the basis for filter, boost, and both UI surfaces. Already true in code; this spec locks it as a constraint so no refactor drops it.
- **Reuse existing seams:** `observation_add`/`/v1/memories` (write, embeds via the just-shipped fix), `resolveSearchResults` (the single ranking chokepoint for `/v1/search` + `/v1/context` + MCP recall), the `obsType`-filter pattern, the decision-log panel pattern, the Observations filter-chip UI.
- **Commit trailer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Branch, never main.** Nothing pushed.

---

## Architecture & Components

```
CAPTURE (write side)
  Directive  → src/services/retrieval/directive.ts        [rule, MemSmith code]
             → delivered by SessionStart + UserPromptSubmit hooks  [machinery]
  Understanding → the agent, at inference (free, full context, natural language)
  Write      → observation_add → POST /v1/memories         [existing; embeds via embed-on-write fix]
                 kind:'user_note', metadata.userDirected:true
  Confirm    → agent echoes "📝 Recorded to memory: …"      [directive-instructed]

SEARCH (read side) — via the one chokepoint resolveSearchResults
  ├─ rank (hybrid RRF)                                      [unchanged]
  ├─ userDirected filter   [NEW — extends obsType-filter seam; /v1/search + /v1/context + repo]
  └─ post-rank transforms:
       ├─ supersession                                      [existing]
       └─ userDirected boost   [NEW — reorder-within-relevant; tunable knob]

DASHBOARD / VIEWER (two surfaces)
  ├─ Dashboard "Notes" panel   [NEW — queries.ts userNotes() + DashboardView card; mirrors Decision log]
  └─ Observations "My notes" filter chip  [NEW — reuses existing type/lifecycle chip UI + fetchObservations]
```

### Components (new/changed)

1. **Record-intent directive** — a new string constant in `src/services/retrieval/directive.ts` (alongside the memory-first directive), delivered by the existing `SessionStart`/`UserPromptSubmit` injection hooks. Instructs: on any user intent to record/remember/log/park/mark/save something, compose a self-contained observation from context and call `observation_add` with `kind:'user_note'` + `metadata.userDirected:true`, then echo a one-line confirmation. On write failure, surface it.
2. **Capture mark** — the `observation_add` MCP tool → `/v1/memories` handler already accept `kind` and `metadata`; the directive supplies `kind:'user_note'` + `metadata.userDirected:true`. No new write plumbing.
3. **`userDirected` search filter** — a new optional boolean param on the `/v1/search` and `/v1/context` request schemas, threaded to `repo.search`/`repo.hybridSearch`. Implemented as a parameterized optional predicate on **`kind`** — `AND ($N::text IS NULL OR kind = 'user_note')` — following the exact `obsType`/`lifecycle_state` optional-filter idiom already in `search` (lines 178-179). `kind` is the primary/canonical filter key (simple column predicate, indexable); `metadata.userDirected` is redundant belt-and-suspenders on the row, not the query key. When the param is true, results are restricted to `kind='user_note'`.
4. **`userDirected` boost transform** — a pure post-ranking reorder inside `resolveSearchResults`, applied after RRF ranking (and composable with supersession): among the ranked results, stable-reorder user-directed observations ahead of ambient ones **without pulling in irrelevant notes** (boost-within-relevant). Strength governed by a new tunable setting (see Settings). Fail-open: any error → return the un-boosted ranked list.
5. **Dashboard "Notes" panel** — a `userNotes()` query in `src/server/dashboard/queries.ts` (`WHERE <scope> AND kind='user_note' ORDER BY created_at DESC`, mirroring the decision-log query) + a card in `DashboardView.tsx` (mirrors the Decision-log panel).
6. **Observations "My notes" filter chip** — a new chip in the Observations view's existing filter UI that adds the `userDirected` filter to `fetchObservations`.

### Placement / boundary decisions
- No new write endpoint — a user note IS an observation, written through the existing marked `observation_add`.
- No new ranking code path — filter and boost are additive stages at the existing `resolveSearchResults` chokepoint, so `/v1/search`, `/v1/context`, and MCP recall all get them uniformly.
- The only genuinely new *UI surfaces* are the Dashboard panel and the Observations chip; both mirror existing patterns.

---

## Data Flow

### Capture
```
User: "park that for later" | "remember we chose X because Y" | "log this" | "mark it"
  → Agent (directive in context + full conversation):
      1. recognizes record-intent (understanding — free, natural-language-complete)
      2. composes a SELF-CONTAINED observation:
           - inline content present → use it
           - referential ("that"/"it") → resolve from conversation into a standalone note
      3. observation_add({ content: <composed>, kind:'user_note',
                           metadata:{ userDirected:true }, projectId:<scope> })
  → Server /v1/memories:
      4. embedForPersist(content) → embedding_vec   [embed-on-write]
      5. repo.create({... kind:'user_note', metadata, embeddingVec})  [persisted, recallable]
  → Agent echoes: "📝 Recorded to memory: <one-line summary>"   [never silent]
```

### Recall — filter (explicit "my notes")
```
"show my saved notes" | "what did I ask you to remember about auth"
  → agent recognizes note-scoped intent → search with userDirected:true
  → resolveSearchResults returns ONLY user-directed observations, ranked
```

### Recall — boost (general query)
```
"why did we pick Postgres?"
  → resolveSearchResults: rank (RRF) → post-rank boost reorders user_notes UP within the relevant set
  → the user's deliberate note surfaces above ambient captures (strength = tunable knob)
```

### Dashboard / Observations
```
Dashboard "Notes" panel   → GET /dashboard/notes  (userNotes(): WHERE scope AND kind='user_note', recent-first)
Observations "My notes"   → fetchObservations(... userDirected filter)
```

### Composition rule (the key content decision)
The agent writes a **self-contained** note, never a fragment. "park that" becomes e.g. *"Decision: defer hard-mode scoping until after embed-on-write ships — user asked to park it,"* not literally "that." The **confirmation echo** lets the user catch a wrong referent immediately and correct it.

---

## Error Handling & Failure Modes

Guiding rule: a record-intent failure loses at worst one note, never breaks the session. **Write failures are LOUD** (the user asked to save); **read failures are QUIET/fail-open** (recall degrading is invisible-and-fine) — the same capture-vs-retrieval asymmetry established for embed-on-write and retrieval-first.

| Failure | Behavior |
|---|---|
| Embedder fails at write | `embedForPersist` → null (best-effort); note persists WITHOUT embedding → still FTS-findable + on dashboard, not semantically-ranked until a backfill. Confirmation still shows "recorded." Never blocks the write. |
| `observation_add` / server unreachable | Write fails → agent surfaces it VISIBLY ("⚠ Couldn't record to memory — say it again / retry"). Never silent — this is the one case the user MUST know. |
| Agent misses intent (false negative) | No confirmation echo appears → the ABSENCE is the signal; user restates. Residual reliability gap of agent-side detection, mitigated by making success visible. |
| Agent over-records (false positive) | Low harm (an extra user_note), visible via confirmation, deletable via `DELETE /v1/memories/:id` (exists). Preferred failure direction over silent misses. |
| Wrong referent composed | Confirmation shows the note → user corrects ("no, I meant X") → re-record. |
| Boost/filter query error (read) | Fail-open: return normal ranked results without boost/filter — never 500, never blocks recall. |
| Dashboard "Notes" panel query fails | Panel shows empty/error state; rest of dashboard renders (per-panel isolation, existing pattern). |

---

## Testing

**Unit (deterministic, no DB/model):**
- Directive content: names the record verbs, instructs compose→`observation_add`(kind/metadata)→confirm→surface-failure; MemSmith-native (no "claude-mem").
- Capture mark shape: `/v1/memories` given `kind:'user_note'` + `metadata.userDirected:true` persists exactly those (round-trip; extends the embed-on-write test — mark survives too).

**Integration (live embedded PG, isolated schema — existing pattern):**
- Filter: user_note + ambient seeded → `userDirected:true` search returns ONLY the note; unfiltered returns both.
- Boost: user_note + ambient both relevant → boost-on ranks the note above ambient; boost-off (knob=0) → original ranking (knob works + off-safe).
- Boost fail-open: force the boost transform to throw → normal ranked results, no 500.
- Mark survives ranking: a user_note via `resolveSearchResults` still carries `kind`/`metadata` in the result row.
- Dashboard `userNotes()`: seeded notes vs ambient → only user-directed, recent-first.

**End-to-end / acceptance (live):**
- Real capture path: marked `observation_add` → embedded (no backfill) → appears in Dashboard "Notes" panel AND Observations "My notes" filter.
- Behavioral proof (the honest one, like retrieval-first's clean-session test): in a real/clean session, a natural record request ("park that…") → agent records it marked, confirmation echo appears, it's recallable. This validates the agent-side *detection* on natural phrasing.

**Not unit-tested:** the agent's natural-language detection itself (that "park it" ⇒ record-intent) — model behavior, validated by the behavioral test + visible-confirmation safety net (same stance as retrieval-first directive reliability).

**Settings/knob:** the boost-strength setting has a conservative default, is read by `resolveSearchResults`, and is tested like the existing `ftsWeight`/`vecWeight`/`rrfK` knobs.

---

## New / changed settings
- `MEMSMITH_USER_NOTE_BOOST` — new; boost strength for user-directed notes in ranked recall. Conservative default (boost-within-relevant, not aggressive surfacing). `0` = off (original ranking). Read by `resolveSearchResults`, mirroring the existing ranking knobs.

## Acceptance Criteria
1. A natural-language record request results in an embedded observation marked `kind:'user_note'` + `metadata.userDirected:true`, with a visible confirmation echo.
2. Recall can filter to user-directed notes (explicit "my notes" queries return only them).
3. In general recall, user-directed notes are boosted above ambient captures within the relevant set; strength is tunable via `MEMSMITH_USER_NOTE_BOOST` and `0` restores original ranking.
4. The user-directed mark survives ranking into result rows (filter/boost/UI all have the signal).
5. Dashboard shows a "Notes" panel of user-directed memory; Observations has a "My notes" filter chip.
6. Write failures are surfaced to the user; read-side boost/filter failures fail open to normal recall.
7. The directive lives in MemSmith code (not CLAUDE.md); capture reuses `observation_add`/`/v1/memories` (no new write endpoint); search reuses `resolveSearchResults` (no new ranking path).
8. `src` typecheck clean; isolated test gate green for touched files. Nothing pushed; work on a branch.

## Deferred (not this spec)
- RRF fusion re-tuning (boost is a reorder, not a weight change).
- Sub-agent record-intent capture.
- The other Tier-1 gaps (hard-mode scoping, sub-agent coverage verification, behavioral validation).
