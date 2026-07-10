# MemSmith — Outstanding Work

> Durable project memory of what's left. Lives in the repo (git-tracked), independent of
> any memory plugin, so switching claude-mem ↔ MemSmith never loses this. Last updated: 2026-07 session.

## State of the project
- **Local `main` @ 80aba0c5+** (restyle 54375797 on top). **Nothing pushed** — local clone only.
- Two features shipped & merged: (1) unified viewer+dashboard UI on `/v1`, (2) Settings/Control panel + real cost story.
- Whole UI restyled to "Warm Signal" (Plus Jakarta Sans + terracotta `#c2410c`, cream `#faf6f0`), from the pitch deck.
- **Dogfood server** runs on `:37900` (Ollama qwen2.5:14b, local-dev bypass, `MEMSMITH_USAGE_METERING=1`).
  Docker deps: `tam-test-pg` :55432, `memsmith-valkey` :6399. Log: `/tmp/memsmith-dogfood.log`.
- Test state: all feature tests pass; full parallel `bun test` has ~31 PRE-EXISTING flaky failures
  (CORS/SSE/request-id/worker-IO) that pass in isolation — not ours (branch base had 109).

## Open items (prioritized)

### 0. DATA MIGRATED + EMBEDDED ✅ (2026-07-10)
- claude-mem's `team-agent-memory` history (2,378 obs — decisions/features/changes/bugfixes/discovery/refactor) migrated into the MemSmith dogfood Postgres store via `scripts/migrate-claude-mem.ts` (idempotent, dry-run-first, read-only source). So MemSmith now HAS this project's full decision/reasoning history — searchable via `/v1/search` (pass `platformSource: null`, since migrated rows have no live-agent platform attribution).
- **Embeddings backfilled** via `scripts/backfill-embeddings.ts` (local ONNX all-MiniLM-L6-v2, 384-dim; idempotent, only null rows). All 2,380 rows now have `embedding_vec` → SEMANTIC search works (`/v1/search` hybrid FTS+vector RRF fusion verified: "why did we pick the database engine" returns storage-architecture obs w/o keyword overlap).
- **Embed-on-write gap CLOSED** (713c8330): `processGeneratedResponse` now embeds new observations on write (pre-computed before the DB txn; best-effort/never-breaks-generation). New MemSmith memory gets `embedding_vec` automatically. `backfill-embeddings.ts` remains for any historical/failed-embed rows.
- Backup of pre-migration target table: `/tmp/memsmith-observations-backup-*.sql`. Rollback = `DELETE FROM observations WHERE id LIKE 'cmem-%'`.
- Re-runnable safely: `bun scripts/migrate-claude-mem.ts --execute` only inserts genuinely-new source rows (claude-mem keeps capturing this live session).

### 1. Decide + execute: dogfood MemSmith as THIS project's plugin (IN DISCUSSION)
- This Claude Code session currently uses UPSTREAM `claude-mem` (thedotmack v13.6.1), NOT MemSmith. (The DATA is now migrated — item 0 — so switching loses no history.)
- `shshalom` marketplace dir is empty and NOT in `~/.claude/plugins/known_marketplaces.json`.
- `sync-marketplace.cjs` targets `~/.claude/plugins/marketplaces/shshalom` — likely STALE (written before repo moved to root); verify before running.
- Switch = build-and-sync + register shshalom marketplace + install MemSmith plugin + (optionally) disable claude-mem@thedotmack + RESTART Claude Code.
- Risks: edits GLOBAL config (`installed_plugins.json`, `known_marketplaces.json` — affects all projects); replaces a working memory tool; first live plugin capture may surface bugs.
- Rollback: back up the two JSONs first; MemSmith data → `~/.memsmith/` (separate store, no mixing).
- CLAUDE.md rule: install-active hooks must be safe-by-default; don't merge install-active work without explicit consent.

### 2. Wire `MEMSMITH_LOCAL_DEV_PROJECT_ID` ✅ CLOSED (2026-07-10)
- Wired parallel to `MEMSMITH_LOCAL_DEV_TEAM_ID` across all 11 hops; bypass now sets authContext.projectId. VERIFIED live: keyless `/v1/search` (no projectId) returns migrated data (was 400), `/dashboard/board` 200 keyless. Dogfood server now launched with `MEMSMITH_LOCAL_DEV_PROJECT_ID=4af1b61f-6299-4234-ae74-9228fdc09a73`. So the Observations view fills keyless.

### 3. Cost panel ✅ VERIFIED CORRECT (2026-07-10)
- The panel works: proved end-to-end (recordServedCompression → usage_events → costPanel) returns real numbers (savedTokens 372, 89% smaller, $0.0019) when compression ACTUALLY occurs (forced tight budget on real rows).
- It reads $0 in normal dogfood browsing NOT because of a bug: migrated rows are small (avg 674 chars, max 1666), so `/v1/context`'s 10,000-char budget never needs to compress them — nothing to save. Truthful behavior; populates naturally with larger memory sets that overflow the injection budget.

### 4. Design follow-ups (user said "work on design later")
- Restyle applied globally, but user hasn't approved the final look yet. Open question: sidebar is a dark rail w/ terracotta accent — user may want it cream/light to match the deck's light-first feel.
- General polish pass on Observations/Dashboard spacing & typography in the new Warm Signal system.

## Deferred / tracked (not started, larger)
- **⭐ UNIFY ON ONE DB (Postgres everywhere) — architecture north star (user-raised 2026-07-10).** Today there are TWO runtimes: worker/SQLite (local, single-user, FTS-only, no team features) and server/Postgres (team, semantic search, all the settings/cost work). This is a historical artifact (SQLite inherited from claude-mem; Postgres added for team), NOT principled — and it costs us: every feature built twice (settings panel is server-only; Ollama had to be added to both), and "going team" requires a SQLite→Postgres migration (we did it manually). User's vision: **local should ALSO be Postgres, so any project can become a team at any time with no migration** — solo memory already in the shape a team needs. KEY FEASIBILITY QUESTION for the brainstorm: can an EMBEDDED Postgres (pglite / embedded-pg, no Docker, in-process) be as frictionless locally as SQLite? If yes → one runtime, worker/SQLite becomes legacy, semantic search everywhere, team-at-any-time is free. If embedded-PG too heavy → two DBs stay pragmatic. NEEDS ITS OWN brainstorm (spec+plan): touches install, runtime selection, the team story, and migration path off SQLite. DECISION: brainstorm properly later, not mid-switch.
- **Team identity & access**: owners, members, self-serve API keys, real multi-user auth, attribution DATA. The UI + settings resolver leave SEAMS (user tier in the resolution chain is dormant; attribution slots exist) but no identity subsystem is built. (Closely related to the unify-on-Postgres item above — "team at any time" needs this too.)
- ~~**Embedding gap**: server-mode generation does NOT populate `embedding_vec`~~ **CLOSED 2026-07-10 (713c8330)** — generation now embeds on write; migrated history backfilled. Semantic search fully live.
- **Quota/rate-limit live-reload**: `monthlyTokenCap`/`monthlyRequestCap`/`rateLimitPerMin` are `boot:true` (middleware wired at setupRoutes); changing them needs a restart. Deliberately deferred (YAGNI — caps change rarely).

## Minor review findings accepted (not blocking, from SDD reviews)
- Enum validate uses `String(value)` (null→'null', rejected by options check anyway).
- `generatorFactory` test-seam doesn't forward `providerHolder`/`settingsResolver` (test-only path).
- `/v1/settings` unhandled HTTP methods → 404 not 405 (no auth reached, no data written — fine).
- Full detail lives in `.git/sdd/progress.md` (the SDD ledger).

## Where the durable memory lives (so we never lose it)
- **This file** — outstanding work.
- `.git/sdd/progress.md` — per-task SDD ledger (every task, review, deviation).
- `docs/superpowers/specs/2026-07-09-settings-control-panel-design.md` — design.
- `docs/superpowers/plans/2026-07-09-settings-control-panel.md` — full task plan (incl. Phase-2 wiring).
- `docs/superpowers/specs|plans/2026-07-08-unified-memsmith-ui*` — the earlier UI feature.
- Git history — 140+ commits, descriptive messages.
