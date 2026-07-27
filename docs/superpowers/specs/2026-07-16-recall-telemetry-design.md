# Recall Telemetry — Measuring Real Memory-Recall Savings

**Date:** 2026-07-16
**Status:** Design — awaiting user review (NOT yet approved for implementation)

## Problem

MemSmith's token-savings story rests on a **discovery-cost-avoided** model: an
observation costs ~N tokens to originally derive, so recalling it instead of
re-deriving the same knowledge (grep specs, read files, reason it out again)
avoids ~N tokens. On the FormaFieldAgent corpus this is roughly a **21×**
overhead ratio (~94M cumulative discovery tokens vs. ~4.48M stored content
tokens).

But this is a *theoretical ceiling*, not a *measured saving*. The critical gap:
`observations.relevance_count` is **unpopulated** — zero of 11,574 observations
have a non-zero value. The system captures **no telemetry on how often a memory
is actually recalled**, so we cannot say how much of that 21× ceiling is
realized in practice. Any "reuse" claim currently rests on the cost-avoided
model alone, with no recall-frequency evidence behind it.

We also confirmed (prior investigation) that recall volume **cannot** be
reconstructed from log grep: raw keyword tallies are inflated by false positives
(e.g. Swift `injectActionResult` source tokens), and retrieval events are not
consistently structured for machine counting. Telemetry must be captured at the
source, in the DB, not reconstructed after the fact.

## Goal

Measure real recall: **how often each observation is served into context**, and
an **honest per-recall estimate of tokens saved** by that recall. Populate the
dead `relevance_count` column and produce a truthful "recall savings" line for
the dashboard cost panel — distinct from the existing *compression* savings line.

## The counterfactual model (decided)

When memory serves an observation, the grep/file-read path it replaced never
runs, so its cost is counterfactual. We estimate it using the observation's
**own recorded `discovery_tokens`** as the proxy for "what re-deriving this
knowledge would have cost."

**Savings basis: NET.**

```
estSavedTokens = max(0, discovery_tokens − readCost)
```

where `readCost` is the token size of the injected rendered content for that
observation, computed with the existing `estimateTokens` (~4 chars/token) helper
in `src/server/retrieval/compressionMetering.ts`. Net (not gross) accounts for
the tokens the memory itself costs to inject, so the number is conservative and
defensible.

**Explicitly a modeled estimate, not a live A/B measurement.** We do NOT run a
shadow grep to measure real avoided cost — that would defeat the purpose and add
cost. The improvement over today is that savings become *per-actual-recall*
(gated on real recall events) rather than a static corpus-wide ratio: we will
finally know *how often* memory is hit, not just the theoretical ceiling.

## Rejected alternatives

- **Category baseline** (fixed avg grep-episode cost credited per recall):
  simpler headline, but less per-observation precision than the discovery-cost
  proxy we already have in the DB.
- **Live A/B shadow grep** (run both, diff real tokens): most accurate, but
  expensive, complex, and self-defeating — it runs the very grep we're avoiding.
- **Count recalls only, no token estimate**: too small; leaves the
  token-savings claim unquantified when we already hold the data to model it.
- **`usage_events` only / `relevance_count` only** (see Storage): rejected in
  favor of the dual write below.

## What triggers a recall event

**Every served observation.** The instrumentation site is the retrieval path —
the single place where observations are returned into agent context:

1. `/v1/context` handler (`ServerV1PostgresRoutes.ts`) — where
   `recordServedCompression` already fires. Recall metering piggybacks on the
   exact same resolved rows, `teamId`, `projectId`, and never-throws guard.
2. The MCP recall backends that inject results: `memory_search` /
   `observation_search` / `smart_search` (via the shared
   `resolveSearchResults` path).

Rules:
- **Dedup within a single response:** an observation served once in a response
  counts as exactly one recall (not once per textual mention).
- A recall is "the observation entered the agent's context," matching the
  "every served observation" decision — it does NOT require the PreToolUse gate
  to have fired, so proactive per-prompt injection recalls are counted too.

## Storage — dual write

Both writes reuse the existing append-only `usage_events` infrastructure and the
`observations` table. Both are env-gated (`MEMSMITH_USAGE_METERING=1`),
fire-and-forget, and wrapped in try/catch so a telemetry failure can NEVER break
retrieval or injection (matching `recordServedCompression` semantics).

1. **`observations.relevance_count`** — atomic increment (`SET relevance_count =
   relevance_count + 1`) per recall. Finally populates the dead column; provides
   a cheap "how hot is this memory" read and a future heat signal for
   ranking/eviction. Batched per response (one UPDATE per served obs, or a
   single `WHERE id = ANY($ids)` bulk increment).

2. **`usage_events kind='recall'`** — one append-only row per recalled
   observation, carrying in `metadata`:
   - `obsId` — the recalled observation
   - `estSavedTokens` — net estimate (also stored as the event `quantity`)
   - `discoveryTokens` — the gross proxy, for transparency
   - `readCost` — injected token size subtracted
   - `query` — the query/derived-intent that surfaced it
   - `mode` — `'context' | 'search' | 'gate'` (which recall path)
   - `teamId`, `projectId`

`usage_events.team_id` is a NOT NULL FK to `teams(id)` — the serving path already
has a resolved team, so no fixture/constraint issue at runtime.

## Surfacing it

- **`/v1/usage`** — extend the `summarize()` output to report recall counts and
  summed estimated recall savings alongside the existing per-kind monthly totals.
- **Dashboard cost panel** — add a **"Recall savings"** line, distinct from the
  existing compression-savings line: total recalls, estimated tokens saved,
  estimated USD saved (priced at the resolved `inputRatePerMtok`, env fallback
  `MEMSMITH_INPUT_RATE_PER_MTOK` default 5). Guard divide-by-zero and zero-recall
  cases to return zeros, matching the existing costPanel pattern.
- **Labeling:** the recall-savings figure is presented plainly (user accepted a
  modeled estimate); code comments and the spec note it is a discovery-cost proxy,
  not a measured A/B result.

## Components (isolation & interfaces)

- `src/server/retrieval/recallMetering.ts` (new) — mirrors
  `compressionMetering.ts`:
  - `buildRecallEvent({ obsId, discoveryTokens, readCost, query, mode, teamId,
    projectId })` → a `usage_events` row shape with `kind='recall'`,
    `quantity=estSavedTokens`.
  - `recordServedRecall({ usageRepo, observationsRepo, rows, query, mode,
    teamId, projectId })` → env-gated, never-throws; computes net savings per
    row, appends recall events, and bulk-increments `relevance_count`.
- Retrieval route (`ServerV1PostgresRoutes.ts`) — one new call site beside
  `recordServedCompression`, passing the already-resolved rows.
- `costPanel` query (`dashboard/queries.ts`) — extended to aggregate
  `kind='recall'` events into the new savings line.
- `/v1/usage` `summarize()` — extended to include recall aggregates.

Each unit is independently testable: the event builder is pure; the recorder
takes injected repos; the panel query is a pure SQL aggregation.

## Error handling

- Telemetry is opt-in (`MEMSMITH_USAGE_METERING=1`) and fail-open: any error in
  metering is caught, logged via `logger.warn` (message only), and swallowed.
- Retrieval/injection responses are never delayed or failed by metering
  (fire-and-forget, same as the existing request/compression metering).
- Observations with null/zero `discovery_tokens` (e.g. legacy migrated rows)
  count toward **recall frequency** but contribute **0 estimated savings** — an
  honest under-count rather than a fabricated number.

## Testing (test-first, mirroring compression-metering suite)

1. Records a `kind='recall'` event AND increments `relevance_count` when an
   observation is served.
2. Records nothing when `MEMSMITH_USAGE_METERING` is unset/`0`.
3. Never throws on a bad/failing usage repo (returns cleanly, retrieval intact).
4. Dedups: an observation mentioned multiple times in one response counts once.
5. Net-savings math: `estSaved = max(0, discovery_tokens − readCost)`, including
   the floor-at-0 case when readCost ≥ discovery_tokens.
6. Zero/null `discovery_tokens` row: recall counted, `estSaved = 0`.
7. `costPanel` aggregates recall events into the new line; zero-recall team
   returns zeros without divide-by-zero.

## Out of scope (YAGNI)

- Live A/B shadow grep measurement.
- Backfilling historical recall counts (no source data exists — starts fresh).
- Recall-frequency-based ranking/eviction (the `relevance_count` heat signal
  enables it later; this spec only populates the data).
- Per-user recall attribution (team/project scope only, matching current model).

## Implementation must-verify (before coding)

- **`discovery_tokens` location.** Prior investigation found the dashboard cost
  panel reads `discovery_tokens` from `observations.metadata`
  (`metadata.discovery_tokens`), NOT necessarily a top-level column. The
  recorder must read it from the same place the panel does. Confirm the exact
  path (column vs. metadata key) against current schema before wiring, and
  handle the null/absent case per Error Handling.
- **`resolveSearchResults` return shape.** Confirm the MCP recall path exposes
  the served rows (with ids + rendered content) at a single point where
  `recordServedRecall` can hook in, mirroring the `/v1/context` site.

## Open caveats accepted by the user

- The recall-savings number is a **modeled estimate** (discovery-cost proxy),
  not a measured avoided-grep cost.
- Legacy rows with no `discovery_tokens` under-count savings (frequency still
  captured).
