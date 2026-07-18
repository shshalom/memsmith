# MemSmith — Outstanding Work

> Durable project memory of what's left. Lives in the repo (git-tracked), independent of
> any memory plugin, so switching claude-mem ↔ MemSmith never loses this. Last updated: 2026-07-18.

## State of the project
- **Local `main` @ b5c8a9b3.** **Nothing pushed** — local clone only (356 commits ahead of origin/main).
- **Two runtimes, one engine** (worker/SQLite is RETIRED):
  - `local` (default, `MEMSMITH_RUNTIME=local`): embedded Postgres in-process on **:55433**, no Docker. First boot imports any legacy SQLite DB with embedding backfill. This is the dogfood + validation runtime.
  - `server` (`MEMSMITH_RUNTIME=server`): same engine against a remote Postgres (team mode).
  - Dogfood server for THIS project runs on **:38879** (embedded PG :55433, Ollama qwen2.5:14b, local-dev bypass). Connection: `postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres`.
- **Shipped & merged features:** unified viewer+dashboard UI; Settings/Control panel + cost story; "Warm Signal" restyle; embedded-PG local runtime; retrieval-first (memory-first consult); **deterministic record-intent** (see below).
- **Local mode is complete & reliable as a solo memory system** — capture, semantic recall, retrieval-first, and deterministic record are all live-proven on the local runtime. No known local-mode bugs.
- Test state: all feature tests pass in isolation; full parallel `bun test` has known PRE-EXISTING flaky failures (CORS/SSE/request-id) that pass in isolation — not ours.

## Recently completed (2026-07-16 → 07-18)

### Retrieval-first + Deterministic record-intent — ✅ COMPLETE & LIVE-PROVEN
The full "consult memory first, and when the user says record/remember keep it in memory (never a file)" capability, in four merged pieces:
- **Retrieval-first** (memory-first directive + hooks; soft enforcement on by default). Hard mode built but over-blocks — see OPEN item 1.
- **record-intent plumbing** (`ecac70ee`): `/v1/record-intent` Layer-2 backstop, content-idempotency (prompt-derived key + partial unique index, migration 005, schema v4→5), embed-on-write on both write paths, `userDirected` search filter + boost, dashboard Notes panel.
- **enforced-user-note-write** (`note_add` MCP tool + `buildUserNoteRequest` enforcer): tagging (`kind='user_note'`, `metadata.userDirected=true`) is machinery the agent can't get wrong. Notes panel moved above Decisions.
- **record-intent interceptor** (`d883a222`): PreToolUse hook rewrites `observation_add` args in-flight (`updatedInput`) to force user-note tags during a record turn — so a note lands correctly REGARDLESS of which tool the agent picks. Live-proven end-to-end (armed session → generic `observation_add` came back `user_note`). A strengthened directive alone failed (1/6); the interceptor is the deterministic fix.
- **record-intent follow-ups** (`e166b182`): (a) audit-write parity on `/v1/record-intent`; (b) provider-agnostic backstop — `providerComplete` honors the user's configured provider (claude/gemini/openrouter/ollama), not Ollama-only; (c) `MEMSMITH_USER_NOTE_BOOST` is now an honest boolean on/off.
- **provider model-defaults fix** (`b5c8a9b3`): `providerComplete` imports each provider's real `DEFAULT_MODEL` (claude→`claude-sonnet-4-6`) instead of guessed literals. LIVE-VALIDATED against real Anthropic API + Ollama (both classify RECORD/NONE correctly). Caught because a guessed `claude-3-5-haiku-latest` 404'd — invisible to unit tests (stubbed fetch), masked by fail-open.

**Known NON-GOAL (deliberate):** subagent-session arming for record-intent. A subagent never hears "remember X" from the user directly; its own writes are agent observations that should NOT be user-notes (would pollute the Notes panel). Revisit only if a concrete case surfaces.

### Data migration + embeddings — ✅ (2026-07-10)
- claude-mem `team-agent-memory` history migrated into the store (`scripts/migrate-claude-mem.ts`, idempotent). Embeddings backfilled (`scripts/backfill-embeddings.ts`, local ONNX all-MiniLM-L6-v2, 384-dim). Semantic search live (hybrid FTS+vector RRF).
- Embed-on-write closed for generation (`713c8330`) AND for manual/record-intent inserts (embed-for-persist shared helper). New memory gets `embedding_vec` automatically.

## Open items (prioritized)

### 1. Hard-mode retrieval enforcement over-blocks — NEEDS NARROW SCOPING (OPEN, 2026-07-16)
- **Status:** retrieval-first shipped in **soft** mode (on by default, delivers the core value). Hard mode (`MEMSMITH_RETRIEVAL_ENFORCEMENT=hard`) is BUILT + proven to work, but OVER-BLOCKS: it gates `Grep|Glob|Read|Bash` and blocks whenever the broker finds ≥1 hit (`MIN_HITS=1`); with a rich corpus nearly every command blocks. Reverted to `soft`.
- **What "handle it" requires** (its own design/tune cycle, not a one-liner): which tools to gate (likely exclude `Bash`); what "strong hit" means (RRF gives ranks, not a calibrated score — needs score exposure or a count/margin heuristic); gate only why-phrased queries; or reconsider whether blanket `PreToolUse` blocking beats soft + strong directive (the agent obeys the directive voluntarily).
- **Refs:** `docs/superpowers/specs/2026-07-15-retrieval-first-design.md`, `docs/superpowers/plans/2026-07-15-retrieval-first.md`.
- **Operational note:** to disable hard mode while it's on, edit `~/.memsmith/settings.json` via a NON-gated path (Node `fs` write) — a gated tool call gets blocked.

### 2. qwen Layer-2 backstop precision/compose-quality — DEFERRED (own spec)
- The local Ollama backstop (qwen2.5:14b) over-fires as a classifier (measured ~3 false positives / 8 negatives) and sometimes composes garbled/wrong notes. Model-bound, not code. This is Layer 2 only — Layer 1 (the agent + note_add) and the interceptor are the primary, reliable path. Tighten `RECORD_INTENT_SYSTEM` and/or the detection prompt; needs its own live re-test loop (no binary pass/fail).

### 3. Design follow-ups (user deferred — "work on design later")
- "Warm Signal" restyle applied globally but final look not yet approved. Open question: sidebar dark rail vs. cream/light to match the deck. General spacing/typography polish on Observations/Dashboard.

## Deferred / tracked (not started, larger)
- **⭐ UNIFY ON ONE DB — north star (mostly delivered).** The two-runtime split (worker/SQLite vs server/Postgres) is resolved on the local side: worker/SQLite is RETIRED; both runtimes now run the same Postgres engine.
  - **Subsystem #1 (embedded-PG local runtime) — ✅ SHIPPED.** `MEMSMITH_RUNTIME=local` = embedded Postgres, no Docker, semantic search everywhere. Answered the feasibility question YES.
  - **Subsystem #2 (private ↔ team unification / migration-free "team at any time")** — OPEN, not started. Because local is already Postgres, "going team" should no longer need a data migration — but the seamless switch is not built/proven.
  - **Subsystem #3 (team identity)** — OPEN. See below.
- **Team identity & access** — OPEN. Owners, members, self-serve API keys, real multi-user auth, attribution DATA. UI + resolver leave SEAMS (dormant user tier, attribution slots) but no identity subsystem exists. Needed for "team at any time."
- **Quota/rate-limit live-reload** — `monthlyTokenCap`/`monthlyRequestCap`/`rateLimitPerMin` are `boot:true` (need a restart to change). Deliberately deferred (YAGNI).

## Minor / test-quality follow-ups (not blocking)
- provider-complete fail-open test: the non-ok test for openrouter/claude/gemini exits via the `!apiKey` gate, so those branches' actual HTTP-error path isn't exercised (test coverage gap; production path is correct + live-proven).
- record-intent endpoint test invokes the classifier twice within one `it` with a shared `writes` array (functional, awkward).
- Enum validate uses `String(value)` (null→'null', rejected anyway); `generatorFactory` test-seam doesn't forward providerHolder/settingsResolver; `/v1/settings` unhandled HTTP methods → 404 not 405. Full detail in `.git/sdd/progress.md`.

## Where the durable memory lives (so we never lose it)
- **This file** — outstanding work.
- **MemSmith memory itself** — the dogfood store now holds the full decision trail for record-intent (search `userDirected:true` or by feature). This is the primary living record.
- `.git/sdd/progress.md` — per-task SDD ledger (every task, review, deviation) incl. record-intent, enforced-user-note-write, interceptor, follow-ups.
- `docs/superpowers/specs|plans/2026-07-16-*` (record-intent, enforced-user-note-write), `2026-07-17-record-intent-interceptor*`, `2026-07-17-record-intent-followups*`, `2026-07-15-retrieval-first*`.
- Git history — descriptive messages; `main` @ b5c8a9b3.
