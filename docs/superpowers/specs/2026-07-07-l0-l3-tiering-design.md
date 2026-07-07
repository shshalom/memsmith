# L0–L3 Tiered Injection — Design

**Grab-spec component:** #7 (Compression / tiering — token efficiency). The spec's
Phase-2 item "tiered L0–L3 loading with selective retrieval." Today retrieval returns
**full** observations and the injection builder drops whole items when the budget is
tight (`buildInjectionBlock`, inject.ts). This design adds **graduated detail**: a
lower-ranked memory is rendered at a shorter tier instead of being dropped, fitting
more signal into a fixed token/char budget.

## Problem

`buildInjectionBlock` (src/server/retrieval/inject.ts) greedily includes items at
FULL detail from N down to 1 until the block fits `maxChars`. It is all-or-nothing per
item: item #6 is either shown in full or not at all. A tight budget therefore throws
away peripheral awareness that a one-line title would have preserved.

## Data foundation (verified)

Stored observations carry the structured fields in `metadata` — `title`, `subtitle`,
`facts[]`, `narrative`, `why` — and `content` is the full render of all of them
(`renderObservationContent`). So any detail level can be reconstructed from a row's
metadata with no re-fetch and no LLM call. Deterministic, no-cost tiering (matches the
grab-spec's "reimplement AAAK as deterministic, no-LLM").

## Tiers

| Tier | Renders | ~Purpose |
|------|---------|----------|
| **L0** | `title` (+ `subtitle` if present) | one-line peripheral awareness |
| **L1** | title + `facts[]` | the gist / what happened |
| **L2** | title + facts + `why` | decision-aware (rationale kept) |
| **L3** | full `content` (incl. `narrative`) | today's behavior |

A row missing a field degrades gracefully (L2 with no `why` == L1). If `metadata`
lacks the structured fields entirely (older rows), all tiers fall back to a
length-truncated slice of `content` (L0 ≈ first line, L3 = full) so tiering never
errors on legacy data.

## Behavior (the product decision — settled)

**Rank-graduated detail.** Highest-ranked items get L3; detail steps down with rank
(L3→L2→L1→L0) as needed to fit the budget. Top memories are seen fully; lower-ranked
ones still contribute at least a title. Best signal-per-token.

Composition with **positioning** (9B, already shipped): tier is assigned by rank
FIRST, then `positionForInjection` places the rendered blocks (best at head, 2nd-best
at tail). Because tier tracks rank, the head/tail anchors are also the most detailed —
reinforcing the "lost in the middle" mitigation. No conflict; tiering runs before
positioning.

## Architecture

One new module: `src/server/retrieval/tiering.ts`.

```ts
export type Tier = 0 | 1 | 2 | 3;

// Deterministic render of one observation at a given tier from its fields.
// Falls back to content-slice when structured metadata is absent.
export function renderAtTier(
  obs: { content: string; metadata: Record<string, unknown> },
  tier: Tier,
): string;

// Assign a tier to each ranked item so the rendered set fits `maxChars`.
// Greedy: start everyone at L3; while over budget, step down the LOWEST-ranked
// item still above L0; drop trailing L0 items only if still over after all are L0.
// Returns the rendered strings in rank order (positioning reorders afterward).
export function tierToBudget(
  ranked: Array<{ content: string; metadata: Record<string, unknown> }>,
  opts: { maxChars: number; maxItems: number },
): string[];
```

`buildInjectionBlock` (inject.ts) is rewritten to call `tierToBudget` for the body
instead of the current whole-item drop loop, then pass the rendered strings to
`positionForInjection` as it does today. The header, private-filter, and `maxItems`
cap are unchanged. Signature and return type of `buildInjectionBlock` are unchanged —
this is an internal behavior swap, so both consumers (`cli/handlers/context.ts`
SessionStart and `cli/handlers/discovery-gate.ts`) get tiering for free.

Off-switch: `MEMSMITH_TIERING` (default `on`). Set `0`/`off` to restore the
whole-item-drop behavior (tierToBudget then only ever emits L3 or drops), so the
change is reversible in production without a redeploy.

## Scope / non-goals (YAGNI)

- **In scope:** `buildInjectionBlock` (the budget-constrained hook injection path —
  SessionStart + discovery-gate). This is where a char budget exists and dropping
  actually happens.
- **Out of scope (noted follow-up):** the `/v1/context` REST route concatenates full
  `.content` under an *item-count* `limit`, not a char budget, so tiering adds little
  there. Left as an optional later item; not built now.
- No LLM summarization — tiers are pure field selection.
- No new "summary" field on the schema — tiers derive from existing metadata.
- No re-ranking — tiering never changes order; it only changes per-item detail.

## Error handling

- Missing/partial metadata → graceful field-level degrade, then content-slice
  fallback (never throws).
- A single item whose L0 still exceeds `maxChars` → hard-slice that L0 to the budget
  (matches today's final hard-cap).
- Tiering must never make injection throw; on any unexpected error the builder falls
  back to the pre-tiering whole-item path (same safety posture as supersession's
  degrade-on-error).

## Testing

Unit tests (no DB needed — pure functions):

1. **renderAtTier L0–L3** — each tier renders the expected fields; L3 == full content.
2. **Field-missing degrade** — L2 with no `why` equals L1; L1 with no facts equals L0.
3. **Legacy row (no structured metadata)** — all tiers fall back to content-slice; L3
   returns full content, L0 returns first line/slice.
4. **tierToBudget fits** — a set that would drop 3 items at full detail instead keeps
   all, with the lowest-ranked stepped down; total ≤ maxChars.
5. **tierToBudget rank-graduation** — top item stays L3, lowest item ends lowest tier.
6. **tierToBudget maxItems cap** — never emits more than maxItems.
7. **Single oversized L0** — hard-sliced to budget, not dropped to empty.
8. **buildInjectionBlock integration** — with a tight maxChars, tiering yields MORE
   visible items than the old drop behavior; header + private-filter still applied;
   positioning still puts best at head/tail.
9. **Off-switch** — `MEMSMITH_TIERING=0` reproduces the whole-item-drop output.
10. **Never-throws** — a row with malformed metadata still produces a valid block.
