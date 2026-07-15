# MemSmith Retrieval-First — Design

**Goal:** Make consulting MemSmith memory the agent's *first* action for the class of
questions memory is uniquely qualified to answer (why / decisions / rationale), and a
default, always-on discipline — not an opt-in feature. Files, specs, and code become the
*fallback*, consulted only when memory is insufficient. This applies to the main agent AND
to spawned sub-agents.

**Status:** Design approved section-by-section (2026-07-15). Next step: implementation plan.

---

## Motivation & the gap this closes

Every memory tool today treats recall as an *optional* tool the agent *might* call. Nothing
changes the agent's decision procedure about *when* to consult memory, so the agent falls
back on its default instinct — grep, read, infer from code. But a whole class of question
has its true answer **only** in memory: the *why* behind a decision is never fully
recoverable from the code it produced. Code shows *what*; memory holds *why*.

MemSmith additionally has a concrete regression here. Per-prompt semantic injection existed
in the retired **worker** runtime (route `/api/context/semantic`, gated on
`MEMSMITH_SEMANTIC_INJECT`, prompt-length ≥ 20, with a 7-test suite). The worker→server
migration **cut** it and re-wired only recent-mode SessionStart injection — a strictly
weaker stand-in adopted for migration expediency, documented in commit `a250d0b3`. The
query-driven engine that would restore it (`POST /v1/context`, hybrid RRF + tiering) **exists
and works today** (verified live) but was never reconnected. So part of this work is
restoring a lost capability; the rest is elevating it to core behavior and extending it to
sub-agents — the King-solution bar, not a "meh" bolt-on.

## Scope

This spec covers three mechanisms as one coherent system:

- **(A) Per-prompt semantic injection** — on every `UserPromptSubmit`, query `/v1/context`
  with the prompt and inject relevant memory (restores the retired capability).
- **(B) Standing retrieval-first directive** — a MemSmith-authored instruction establishing
  "memory is the first source for why/decision questions; files are fallback; flag gaps,"
  delivered so it reaches the main agent AND sub-agents.
- **(C) PreToolUse interception** — when any agent (main or sub) reaches for a search/read
  tool, consult memory first and inject-or-(optionally)-block; flag the gap on a miss.

**Core, not aftermarket.** All three are **on by default, always** — installing MemSmith
makes the agent retrieval-first out of the box, with no flag to discover and enable. The
existing `MEMSMITH_SEMANTIC_INJECT` default flips from `'false'` to `'true'` (retrieval-first
is what MemSmith *is*). Behavior is tunable (depth, directive strength, relevance floor,
enforcement mode) but the discipline itself is the product's default posture.

### Out of scope (deferred to their own specs)
- **Live memory verification** — checking a recalled claim against current code before
  trusting it (the continuous cousin of the `/phase-start` audit). This spec injects memory
  as *provenance-tagged, authoritative-but-verifiable*; it does not verify on the hot path.
  Rationale: verification on every prompt blows the latency budget and is a distinct
  subsystem (memory-health auditing), not part of the retrieval hot path.
- **The `/phase-start`-style phase-boundary audit** (already exists as a user command).

## Global Constraints

- **On by default:** `MEMSMITH_SEMANTIC_INJECT` default becomes `'true'`. Retrieval-first is
  never gated behind a discovery step. Tunable, but on out of the box.
- **Fail open, always:** retrieval-first sits on the hot path of every prompt and tool call.
  Any failure (server down, timeout, missing key, corrupt state) degrades to "agent proceeds
  normally, no memory assist this turn." It must NEVER block the agent due to its own failure.
  Loud in logs; invisible to the agent's ability to proceed.
- **Latency wins:** if the King-solution goal and hot-path latency conflict, latency wins. A
  fast agent that occasionally misses an injection beats a sluggish one.
- **Write vs. read asymmetry:** capture failures are durable/retried (lost memory is gone);
  retrieval failures are dropped/fail-open (un-injected memory can be injected next turn).
- **Complete separation:** MemSmith-native design. The claude-mem `PreToolUse:Agent`
  memory-first pattern proves the category is viable but is NOT ported; MemSmith's version is
  its own, wired to MemSmith's engine and `ms-mem-search` tools.
- **Reuse the proven engine and key path:** `/v1/context` (hybrid RRF + tiering) and the
  `ServerClient` + credential-store key resolution fixed earlier this session.

---

## Architecture & Components

A single internal **RetrievalBroker** owns all memory-consultation logic. Thin hook adapters
call it; it calls the existing `/v1/context` engine over HTTP (hook-side, like capture).

```
MAIN AGENT                                    SUB-AGENT (isolated context)
──────────                                    ────────────────────────────
SessionStart ──▶ inject directive (B)          [no SessionStart fires]
UserPromptSubmit ──▶ broker.forPrompt (A)      [no UserPromptSubmit fires]
PreToolUse ──▶ broker.forToolIntent (C)        PreToolUse ──▶ broker.forToolIntent (C) ✓
PreToolUse:Agent ──▶ inject directive          CLAUDE.md/skill ──▶ directive baseline ✓
   into Task framing (propagates) ─────────▶
                    │
                    ▼
        ┌──────── RetrievalBroker ────────┐
        │  forPrompt(text)                 │
        │  forToolIntent(tool, args)       │
        │  • query /v1/context (hybrid)    │
        │  • provenance-tag                │
        │  • session dedup                 │
        │  • gap-flag on miss              │
        │  • enforcement policy (soft/hard)│
        └──────────────┬───────────────────┘
                       ▼   /v1/context (proven engine)
```

### Components

1. **`RetrievalBroker`** (`src/services/retrieval/`) — the core. Public: `forPrompt(promptText)`,
   `forToolIntent(toolName, toolArgs)`. Internal: `queryContext`, `tagProvenance`, `dedup`,
   `flagGap`, and an enforcement-policy consult. Holds per-session state (what memory it has
   already surfaced) via a session file (see Data Flow).
2. **Directive module** (`src/services/retrieval/directive.ts`) — the authored memory-first
   instruction text (MemSmith-native), plus its delivery framing. Delivered three ways for
   full main+sub-agent reach.
3. **Hook adapters** — thin handlers for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
   and a new `PreToolUse` matcher on the `Agent`/`Task` tool. Each translates hook I/O ↔
   broker call → `additionalContext`. NO memory logic lives in the hooks.
4. **Enforcement policy** — a single soft/hard knob the broker consults, so enforcement
   strength lives in one place rather than duplicated across mechanisms.

### Placement decision
The broker runs **hook-side** (in the short-lived hook process), calling the server over
HTTP — same as capture. It does NOT live in the server. Hooks are where the agent's context
is assembled, and this reuses the proven `ServerClient` + key-resolution path.

### Universal-chokepoint principle
`PreToolUse` is the ONLY hook that fires in *both* main and sub-agent contexts (confirmed via
Claude Code hooks docs). Sub-agents receive no `SessionStart` and no `UserPromptSubmit`, and
**no hook can inject across the sub-agent isolation boundary** (a parent `SubagentStart`/
`PreToolUse:Agent` hook's `additionalContext` lands in the *parent*, not the child). Therefore
**(C) is the load-bearing guarantee for universality**; (A) and (B) are main-agent
enhancements layered on top. Sub-agent directive reach is achieved by the three-path delivery
below, not by cross-boundary injection (which is impossible).

---

## Data Flow

### (A) Per-prompt injection — main agent, every prompt
```
UserPromptSubmit(prompt) → broker.forPrompt(prompt)
  → POST /v1/context { query: prompt, projectId, limit: MEMSMITH_SEMANTIC_INJECT_LIMIT }
  → results ranked hybrid (RRF + tiering)
  → dedup against session-shown set
  → provenance-tag each result (obs_type, captured-date, id)
  → if results (≥ relevance floor): inject as additionalContext, framed
        "relevant recorded memory — authoritative-but-verifiable"
  → if empty/weak: gap-flag per on-miss policy
```

### (C) Tool interception — main AND sub-agent, on search/read tools
```
PreToolUse(tool, args) → tool ∈ SEARCH_INTENT_TOOLS ? → broker.forToolIntent(tool, args)
  → derive query from args (search pattern / file path / command substring)
  → same /v1/context path as (A)
  → soft: inject "MemSmith memory has X — consult before this search"
  → hard (variant): block once when hit ≥ floor AND not-yet-consulted this turn
  → gap-flag on miss (no hit ≥ floor) → ALWAYS allow the tool through
```
`SEARCH_INTENT_TOOLS` and query-derivation are specified under **Trigger Definitions** below.

### (B) Directive delivery — three MemSmith-native paths
```
main-agent baseline:   SessionStart → inject directive text once per session
sub-agent propagation:  PreToolUse:Agent (on Task/Agent spawn) → embed the directive in the
                        Task framing so it rides into the sub-agent's task message
sub-agent baseline:     CLAUDE.md / preloaded skill → directive always present in the
                        sub-agent's startup context (non-Explore/Plan sub-agents load the
                        memory hierarchy)
```
No single path crosses the isolation boundary; together they ensure every agent — main or
sub — carries the directive, with (C) as the in-context safety net regardless.

### Session dedup state
Hooks are short-lived separate processes and do not share memory between invocations. "What
memory have I already injected this session?" persists to a **session-scoped file**:
`~/.memsmith/sessions/<sessionId>/shown.json` (list of injected observation ids). Each hook
invocation reads it, filters already-shown results, appends newly-shown ids. Chosen over a
server round-trip because the server knows what it *served*, not what the hook chose to
*inject* (they differ); and over no-dedup because re-injecting the same memory is noise that
fails the King bar. Corrupt/unwritable file → treat as empty set (may re-inject), never throw.

---

## Trigger Definitions

### Why-class detection — two distinct definitions by mechanism

"Why-class" means different, deliberately-chosen things for the directive vs. the code-side
interception, because a hook handler cannot linguistically judge a query the way a model can:

- **(B) directive — model-judged.** The directive states the rule ("for why/decision/
  rationale questions — the user's or your own — consult MemSmith memory first; files only if
  memory is insufficient"); the model itself decides what qualifies each turn. No code
  classifier. Validated by the directive-reliability harness (see Testing). **If the harness
  shows the model's judgment is unreliable (below threshold) on a surface, that surface flips
  to always-memory-first** (memory consulted first for everything, files always the fallback).

- **(A)/(C) code path — operationalized as "a strong memory hit exists."** `forPrompt` and
  `forToolIntent` do NOT attempt linguistic why-class classification. They always query
  `/v1/context` and let the **relevance floor** decide: a result at/above
  `MEMSMITH_RETRIEVAL_MIN_SCORE` means memory *has* a relevant recorded answer → inject
  (soft) or block-eligible (hard). Below the floor → treat as a miss → gap-flag → proceed.
  This is the honest, implementable definition: the code does not guess whether a grep is a
  "why" question — it asks memory, and a strong hit *is* the signal that this search has a
  recorded answer worth surfacing first. Hard-mode blocking therefore keys on
  "strong-hit-the-agent-is-about-to-bypass," never on a linguistic label.

### `SEARCH_INTENT_TOOLS` (which tools trigger (C))
The interception fires for tools whose purpose is discovery/search:
- `Grep`, `Glob` — always search intent.
- `Read` — discovery read (gated: only when it looks like exploration, not a re-read of a
  file already in context; the existing file-context stat-gate pattern informs this).
- `Bash` — only when the command is a search (`grep`/`rg`/`find`/`ag` prefix). Non-search
  Bash is ignored.
Non-search tools (Edit, Write, Task-side-effects, etc.) never trigger (C).

### Query derivation from tool args
- `Grep`/`Bash-grep`: the search pattern string.
- `Glob`: the glob pattern (path stem).
- `Read`: the file path (basename + dir as query terms).
The derived string is the `/v1/context` query.

### Relevance floor
`MEMSMITH_RETRIEVAL_MIN_SCORE` (tunable). `/v1/context` results carry ranking scores. A
result at/above the floor is a "strong hit" (eligible for injection and hard-mode blocking);
below the floor is treated as a miss (→ gap-flag). One knob, not scattered magic numbers.

---

## Enforcement Variants

Both variants are designed; the enforcement mode is a per-mechanism setting chosen at review.

### Soft (inject-only, non-blocking) — the safe default
Broker injects memory (or a "memory has X, consult first" pointer) but never blocks a tool.
Memory is made impossible to miss; the model retains final control. Zero friction, cannot
wedge the agent. Relies on the model heeding the injection (hence the reliability harness).

### Hard (block-eligible, PreToolUse only)
On a search where memory returns a **strong hit** (≥ `MEMSMITH_RETRIEVAL_MIN_SCORE`) AND the
agent has NOT yet consulted memory this turn, `PreToolUse` returns a single deny with a
message: "Consult MemSmith memory first — relevant recorded context exists. Query
ms-mem-search, then re-run." The agent does the memory step; the tool is then allowed. The
only true *guarantee* of memory-first. Keyed on the strong-hit signal (the operational
why-class definition above), never on a linguistic label — so it fires precisely when memory
demonstrably has a recorded answer the agent is about to bypass. Must be scoped narrowly to
avoid friction.

**Critical scoping rule (hard mode):** NEVER block when memory is empty/weak for the query
(blocking to force a consult that returns nothing = pure friction). Hard-block fires ONLY on
a strong hit the agent is about to bypass. **Fail open:** if enforcement cannot verify a hit
(query errored/timed out), it must NOT block.

---

## On-Miss / Gap Handling

Decision: **flag the gap, then fall through.** When memory is consulted for a why/decision
question and returns nothing at/above the floor:
```
→ inject a short note: "⚠ No MemSmith memory found for this — the rationale may not have
   been captured. Proceeding to files/specs."
→ persist a lightweight gap record (obs_type: 'memory_gap') so missing rationale becomes
   visible (dashboard can surface "N un-captured rationales") and could later be backfilled
→ ALWAYS allow the tool / proceed (never block on a miss)
```
This turns misses into **signal** — a growing, actionable list of decisions whose *why* was
never recorded — rather than silent fallthrough. It is the self-improvement loop that
differentiates a King solution: memory that reveals its own gaps. Gap persistence is
best-effort: a failed write swallows and still injects the ephemeral note.

---

## Error Handling & Failure Modes

Overriding rule: **retrieval-first must NEVER block the agent from working due to its own
failure.** Fail open, everywhere; loud in logs, invisible to the agent's ability to proceed.

| Failure | Behavior |
|---|---|
| Server unreachable (`:38879` down / cold boot) | Broker returns empty → inject nothing → proceed. Log once at debug. |
| `/v1/context` slow | Hard timeout `MEMSMITH_RETRIEVAL_TIMEOUT_MS` (default ~2000ms) → proceed without injection. |
| Missing/unresolvable key | Skip gracefully (log fallback reason — never the old silent drop). |
| Hard-mode block but server errored | **Fail OPEN** — cannot verify a hit → do NOT block. |
| Session dedup file corrupt/unwritable | Treat as empty set (may re-inject) → proceed, never throw. |
| Sub-agent, directive not propagated | (C) interception still fires in-child; CLAUDE.md baseline still present. Degraded, not broken. |
| Gap-record write fails | Swallow → inject ephemeral note anyway → proceed. |

**Latency budget:** (A) and (C) each add one `/v1/context` call, bounded by the timeout. If
latency and completeness conflict, latency wins (also why verification is deferred).

---

## Testing

### Unit (broker; fake pool/client, deterministic)
- `forPrompt`: query built correctly; results provenance-tagged; dedup against shown-set;
  gap-flag on empty; respects `MEMSMITH_SEMANTIC_INJECT_LIMIT`.
- `forToolIntent`: query derived correctly from Grep/Glob/Read/Bash args; non-search tools
  ignored; `SEARCH_INTENT_TOOLS` gate correct.
- Enforcement: soft → always injects, never blocks. Hard → blocks ONLY when (why-class AND
  not-yet-consulted AND score ≥ floor); fail-open when query errors; never blocks on miss.
- Fail-open: every failure path (server down, timeout, corrupt dedup file, missing key) →
  returns empty/allow, never throws.
- Relevance floor separates hit from gap at `MEMSMITH_RETRIEVAL_MIN_SCORE`.

### Integration (live embedded PG)
- Seed observations → `forPrompt` returns real, hybrid-ranked relevant memory.
- Full hook path: synthetic `UserPromptSubmit` / `PreToolUse` → correct `additionalContext`.
- Sub-agent: `PreToolUse` firing with `agentId` set still intercepts (chokepoint holds).
- Timeout: point at a dead port → proceeds within budget, injects nothing.

### Directive-reliability harness (the decision gate) — `bench/retrieval-first/`
Determines directive-based (keep) vs. always-memory-first (fallback), per surface.
- **Evaluation set:** ~20–30 fixed prompts — why/decision (should trigger memory-first),
  routine file-location (should NOT), and ambiguous.
- **Metric:** with only the directive active (no interception), did a `/v1/context` /
  `ms-mem-search` call precede the first file search on why-class prompts? Measured via
  MemSmith telemetry.
- **Threshold:** ≥ 90% of why-class prompts consult memory first. **Below → flip that surface
  to always-memory-first.**
- **Repeatable:** a harness script re-runnable as models change, so "is the directive still
  reliable?" stays answerable over time.

### Explicitly NOT tested here
- Live memory verification (deferred spec).
- Broad multi-turn agent behavior beyond the reliability harness.

---

## New / changed settings
- `MEMSMITH_SEMANTIC_INJECT` — default flips `'false'` → `'true'` (core-on).
- `MEMSMITH_SEMANTIC_INJECT_LIMIT` — existing (default `5`), reused as (A)/(C) result cap.
- `MEMSMITH_RETRIEVAL_MIN_SCORE` — new, relevance floor for hit-vs-gap and hard-mode.
- `MEMSMITH_RETRIEVAL_TIMEOUT_MS` — new, hot-path timeout (default ~2000).
- Enforcement mode per mechanism (soft/hard) — new, chosen at review.

## Acceptance criteria
1. Fresh install → (A) per-prompt injection, (B) directive, (C) interception all live with NO
   flag enabled; `MEMSMITH_SEMANTIC_INJECT` defaults `'true'`.
2. On a why/decision prompt with relevant memory, memory is injected/consulted before the
   agent reaches files (soft) or is required before a why-class search (hard), per configured
   mode.
3. Sub-agents: a sub-agent's search tool call triggers (C) interception; the directive reaches
   sub-agents via Task-framing propagation and/or CLAUDE.md baseline.
4. On a miss, a gap note is injected and a `memory_gap` record persisted; the agent always
   proceeds.
5. Every failure mode fails open — the agent is never blocked by retrieval-first's own error.
6. The directive-reliability harness runs, scores the eval set, and its threshold drives the
   always-memory-first fallback per surface.
7. Nothing about capture regresses; retrieval reuses `/v1/context` + the fixed key path.
