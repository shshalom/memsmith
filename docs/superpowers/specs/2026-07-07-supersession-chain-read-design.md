# Supersession-Chain Read — Design

**Grab-spec component:** #8 (Decision record — "the why"). The `supersedes` column
ships write-only today (schema.ts:375, observations.ts:138) — it is populated from
generation XML but never read. This design makes the chain **queryable and
behavior-bearing** so decisions supersede one another in retrieval and in the
dashboard decision-log.

## Problem

An observation Y that replaces an older decision X is stored with `Y.supersedes = X`.
Nothing consumes this: search and context return superseded observations as if
current, and the dashboard decision-log lists every decision flat with no lineage.
Agents can therefore be primed with a decision that has since been reversed — the
exact failure the "memory-first / act on current truth" moat is meant to prevent.

## Behavior (the product decisions — settled)

The chain direction is **backward-pointing**: `supersedes` on the newer row points at
the older row it replaced. "Find the current decision starting from X" means walking
**forward**: repeatedly find the row whose `supersedes` equals the one in hand.

| Surface | Behavior | Rationale |
|---|---|---|
| **Context injection** (`/v1/context`) | **Collapse to head.** A superseded hit is replaced by the current head of its chain (deduped if the head is already present). | Injection silently primes the agent; it must carry current truth only. |
| **Explicit search** (`/v1/search`, MCP recall) | **Annotate, don't hide.** A superseded hit is kept but tagged `supersededBy: <headId>`; the head is ensured present in results. | A deliberate query should never lose information; transparency over magic. |
| **Dashboard decision-log** | **Render lineage.** `decisionLog()` groups decisions into supersession chains (head + ordered history). | Makes the "decision + why + supersession chain" moat visible. |

Both retrieval surfaces share one primitive; the only difference is replace vs.
annotate.

## Architecture

One new module: `src/server/retrieval/supersession.ts`.

### Core primitive

```ts
// Walk a single chain forward (old → newer) to the current head id.
// Scoped: a chain can never cross a team/project boundary.
// Cycle/runaway guard: visited-set + depth cap (MAX_CHAIN_DEPTH = 16).
async function resolveSupersessionHead(
  db: PostgresQueryable,
  startId: string,
  scope: { teamId: string; projectId?: string },
): Promise<string>            // head id (equals startId if already current)

// Batch entry point used by search/context: resolve many ids at once,
// memoizing so shared chains are walked once per batch.
async function resolveHeads(
  db: PostgresQueryable,
  ids: string[],
  scope: { teamId: string; projectId?: string },
): Promise<Map<string, string>>   // originalId -> headId
```

Inner walk:

```
current = startId; visited = {startId}
loop up to MAX_CHAIN_DEPTH:
  successor = SELECT id FROM observations
              WHERE supersedes = current AND team_id = $t [AND project_id = $p]
              ORDER BY created_at DESC LIMIT 1     -- newest wins on fork
  if none            -> break (current is head)
  if successor in visited -> break (cycle guard)
  visited.add(successor); current = successor
return current
```

`MAX_CHAIN_DEPTH` is overridable via `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH` (clamp 1–256,
default 16) for the pathological deep-chain case; not expected to be set.

### Consumers

**A. Context (`resolveSearchResults` → context branch):** after ranking, call
`resolveHeads` on the result ids. For each superseded hit, replace it in place with
its head row (fetch head rows not already in the set via a single scoped
`WHERE id = ANY($ids)` query). Dedupe so a head appearing twice collapses to one,
preserving best rank position.

**B. Search (`/v1/search`, MCP recall):** same `resolveHeads` call, but keep the
superseded hit and set `supersededBy` on it; append any head rows not already in the
set (scoped fetch), ranked just after their superseded child. The result item type
gains an optional `supersededBy?: string | null`.

**C. Dashboard (`decisionLog`):** replace the flat list with chain grouping —
partition decisions into chains via `supersedes`, return `{ head, history[] }[]`
ordered by head recency. `ui.html` renders head prominently with a collapsed history
trail.

### Wiring point

Both retrieval surfaces already funnel through `resolveSearchResults`
(ServerV1PostgresRoutes.ts:926, 972) — supersession resolution hooks there, gated on
mode (context=collapse, search=annotate). No change to the auth guards or the
hybrid-ranking path; supersession is a post-ranking transform.

## Data model

No schema change. Uses the existing `supersedes TEXT REFERENCES observations(id)`
(schema.ts:375). `supersededBy` on search results is a response-only field, not
stored.

## Error handling

- **Cycles** (A↔B): visited-set breaks the walk, returns the last node reached; never
  loops. A one-line `console.warn` notes the cycle for observability.
- **Dangling FK** (`supersedes` points at a deleted row): the FK is
  `ON DELETE SET NULL`, so this cannot persist; a walk simply finds no successor.
- **Head fetch miss** (head id not returned by the scoped fetch — e.g. cross-scope
  pointer that slipped in): the original hit is left as-is (search) or kept unmodified
  (context); resolution degrades to today's behavior rather than dropping a result.
- **DB error in resolution:** caught per-batch; on failure the un-resolved ranked
  results are returned unchanged (retrieval never 500s because of supersession).

## Testing

Postgres-gated integration tests (test container :55432), one schema per test via
`poolForSchema`:

1. **Linear chain head resolution** — X←Y←Z; `resolveSupersessionHead(X)` = Z.
2. **Already-head** — `resolveSupersessionHead(Z)` = Z (no successor).
3. **Fork (two supersede X)** — newest by `created_at` wins.
4. **Cycle guard** — X supersedes Y, Y supersedes X; walk terminates, no hang.
5. **Depth cap** — chain longer than cap stops at cap, returns a valid id.
6. **Scope isolation** — a successor in another team/project is NOT followed.
7. **Batch memoization** — `resolveHeads` over a shared chain issues bounded queries
   and returns correct heads for every input id.
8. **Context collapse** — a superseded hit is replaced by its head; dedupe when head
   already present; rank order sane.
9. **Search annotate** — superseded hit retained with `supersededBy` set; head ensured
   present.
10. **decisionLog chain grouping** — chained decisions grouped head+history; unchained
    decisions appear as singleton chains.
11. **Degrade-on-error** — forcing a resolution failure returns ranked results
    unchanged (no 500).

## Non-goals (YAGNI)

- No write-side chain construction (generation already sets `supersedes`).
- No automatic lifecycle flip to `superseded` (that is generation/parser behavior,
  out of scope here).
- No graph traversal beyond linear supersession (KG is Phase 4).
- No new env flag to disable the feature — collapse/annotate are the correct default
  behaviors; the only knob is `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH`.
