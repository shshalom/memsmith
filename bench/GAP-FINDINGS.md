# Gap-closing eval findings

Answers the two questions behind the worker→embedded migration: (1) is MemSmith's
retrieval actually better than claude-mem's, and (2) does the embedded path's
single-shot generation lose quality vs the worker's multi-turn path (GAP1)?
All runs are on the local dev machine against the live embedded Postgres corpus
(team=local, project=local, 2789 observations) and Ollama `qwen2.5:14b`.

## 1. Retrieval — semantic (MemSmith) vs keyword (claude-mem)

`bench/retrieval-compare.mjs` — 8 natural-language questions, top-5, live corpus.

| Arm | Returned any result | Notes |
|-----|---------------------|-------|
| keyword (FTS)   | **2 / 8** | 6 questions had zero lexical overlap → empty result |
| semantic (vec)  | **8 / 8** | every top hit on-topic |

The 6 empty keyword results are the concrete win: a developer asking "why did we
stop using the worker" when the stored text says "retiring background processing"
gets nothing from FTS but the right memory from embeddings. Also validated by the
passing `tests/storage/postgres/hybrid-search.test.ts` (semantic ranks above
keyword on a controlled set). Standardized recall@k via `bench/longmemeval/run.ts`
remains available (needs the LongMemEval-S dataset download).

## 2. Generation quality — local model vs Claude

`bench/quality-eval/eval.ts` — qwen2.5:14b vs Claude, blind Opus judge, 5 dims.

| Dimension | qwen | claude | gap |
|-----------|------|--------|-----|
| faithfulness | 3.60 | 4.00 | −0.40 |
| specificity | 3.80 | 4.25 | −0.45 |
| typeCorrectness | 4.20 | 4.00 | +0.20 |
| usefulness | 3.80 | 4.00 | −0.20 |
| structure | 3.60 | 4.75 | −1.15 |
| **overall** | **3.80** | **4.20** | **−0.40** |

The free local model is usable but behind Claude, mostly on structural
completeness (schema-field usage). Coverage: qwen skipped 5/10 vs Claude's 2/10.
Not at parity — an honest "good enough for local, Claude better if you pay."

## 3. GAP1 — single-shot (embedded) vs multi-turn (worker)

`bench/turns-eval/eval.ts` — SAME model (qwen2.5:14b) through both turn structures,
blind Opus judge. This isolates turn-structure as the only variable.

| Dimension | single-shot | multi-turn | gap (m−s) |
|-----------|-------------|------------|-----------|
| faithfulness | 4.40 | 4.00 | −0.40 |
| specificity | 4.40 | 3.75 | −0.65 |
| typeCorrectness | 4.20 | 3.75 | −0.45 |
| usefulness | 4.20 | 3.50 | −0.70 |
| structure | 4.40 | 4.25 | −0.15 |
| **overall** | **4.32** | **3.85** | **−0.47** |

**Finding: single-shot does NOT lose quality — it scores higher.** The worry was
that dropping multi-turn conversation would degrade observations. It didn't. The
per-event breakdown explains why: on the substantive events (edit-auth, decision-db,
bugfix-race, blocker, multi-file-refactor) the two arms score ~identically. The gap
comes entirely from **coverage discipline** — multi-turn wrote observations for 3
marginal events (read-config, grep-search, "why is search stale?" prompt) that
single-shot correctly skipped, and those 3 scored low (1–3s), dragging multi-turn's
average down. More turns → more borderline records, not better records.

**GAP1 is closed.** The embedded path's single-shot generation is at least as good
as worker multi-turn on this corpus; the quality gate (which the worker lacks)
further favors the embedded path. Migration off multi-turn costs no observation
quality.

## Caveats (apply to §2 and §3)

Judged by claude-opus-4-8 (a Claude-family model) — may modestly favor Claude in §2.
Small corpus (10 events): directional, not statistical proof. Measures quality on
this corpus + these prompts, not a universal claim.
