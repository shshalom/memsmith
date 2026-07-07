# Local Query Expansion — Design

**Goal:** Lift single-session retrieval recall (esp. single-session-user 0.871, single-session-preference 0.800) by expanding the QUERY before embedding, without re-embedding stored data or adding dependencies.

**Root cause (from systematic-debugging diagnostic):** all-MiniLM ranks obliquely-phrased single-session answers deep (vector rank 17–26). The answer session shares little vocabulary with the question ("How long is my commute?" vs a session mentioning commuting in passing). Weighted RRF only rescued fusion-demotion cases, not vector-recall misses.

**Approach (chosen: staged, local no-LLM):** deterministic query expansion — strip interrogative framing and produce content-term variant(s); embed each variant; fuse per-variant vector rankings via existing RRF before fusing with FTS. Offline, no LLM, no new dependency, opt-in by default (measure on LongMemEval, promote to default only if it lifts weak types with no regression). If the lift is insufficient, escalate to a stronger embedder (Stage 2, separate).

## Components (src/server/retrieval/)
1. `query-expansion.ts` — pure `expandQuery(query): string[]`. variant[0] = original (always); variant[1] = de-framed (strip leading interrogative framing + trailing '?', collapse to content terms). Deterministic, dependency-free.
2. `observations.ts` hybridSearch/vectorSearch — internal multi-query path: embed each variant, KNN each, RRF-fuse variant rankings into one vector ranking, then RRF-fuse (weighted) with FTS. Gated by MEMSMITH_QUERY_EXPANSION=1 (or a hybridSearch param); default OFF until measured.

## Data flow
query -> expandQuery() -> [v0,v1,...] -> embed each -> vectorSearch each -> RRF-fuse -> RRF-fuse with FTS(weighted) -> filter -> trim.

## Testing
- Unit: expandQuery strips framing, always retains original, deterministic.
- DB: a de-framed oblique query surfaces the target obs where the raw query buried it.
- Measurement (the gate): LongMemEval A/B (expansion off vs on), full 500. Keep only if weak types improve and none regress.

## Honest risk
Failing queries are short/clean with little framing to strip; gold is deep (rank 17–26). Expansion may move ranks only modestly. Stage 1 is an experiment measured on LongMemEval; if the gain is negligible, proceed to Stage 2 (bigger embedder).
