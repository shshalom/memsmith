# LongMemEval-S Benchmark Harness

This is the **go/no-go gate** for the Team Agent Memory project (SPEC §5 / PLAN §3).

**PASS BAR: R@5 ≥ 0.90**

If R@5 falls below 0.90 after tuning, escalate the build-vs-adopt decision. Reference points: agentmemory 0.952, MemPalace 0.966.

---

## 1. Download the Dataset

LongMemEval-S is available from the paper's GitHub repository:

```
https://github.com/xiaowu0162/LongMemEval
```

Follow the instructions there to download the dataset. The harness expects a JSON
file (array) with items in this shape:

```json
[
  {
    "id": "<item-id>",
    "question": "What was the user's travel plan for July?",
    "gold_ids": ["<obs-id-that-contains-the-answer>"],
    "corpus": [
      { "id": "<obs-id>", "content": "...", "timestamp": "2025-01-15T10:00:00Z" },
      ...
    ]
  },
  ...
]
```

If the upstream format differs (e.g., separate evidence/corpus files), adapt the
dataset or write a small conversion script before running the harness.

---

## 2. Required Environment Variables

| Variable | Description |
|---|---|
| `LME_DATASET_PATH` | Absolute path to the LongMemEval-S JSON file. |
| `MEMSMITH_TEST_POSTGRES_URL` | Postgres 16 + pgvector connection string (e.g. `postgresql://user:pass@localhost:5432/lme_bench`). The harness will create its own schema tables. |
| `MEMSMITH_RRF_K` | (Optional) RRF constant k, default 60. Tune this if R@5 is below bar. |

---

## 3. Run the Benchmark

```bash
LME_DATASET_PATH=/path/to/longmemeval-s.json \
MEMSMITH_TEST_POSTGRES_URL=postgresql://user:pass@localhost:5432/lme_bench \
/Users/shwaits/.bun/bin/bun run bench/longmemeval/run.ts
```

The runner will:

1. Bootstrap the Postgres schema (pgvector + FTS columns) in a scratch project.
2. For each dataset item, embed and ingest all corpus observations.
3. Embed the question and run `hybridSearch()` (RRF over vector + FTS).
4. Compare the top-K retrieved IDs against the gold IDs.
5. Print R@5, R@10, and MRR; exit 0 on pass, exit 2 on fail.

---

## 4. Pass / Fail Decision

| Metric | Pass bar | Reference points |
|---|---|---|
| **R@5** | **≥ 0.90** | agentmemory: 0.952, MemPalace: 0.966 |
| R@10 | informational | — |
| MRR | informational | — |

- **R@5 ≥ 0.90** → Sprint 3 is unblocked. Proceed to building differentiators.
- **R@5 < 0.90** → Tune and re-run. Knobs to try:
  - `MEMSMITH_RRF_K` (lower = stronger BM25/vector bias)
  - RRF weight ratio (vector vs. FTS) in `hybridSearch()`
  - Chunk size / overlap at ingest time
- **R@5 stays materially below 0.952 after tuning** → Escalate the
  build-vs-adopt decision. Adopting agentmemory's retrieval engine becomes the
  stronger option. Do NOT start Sprint 3 until this clears.

---

## 5. Unit Tests (scoring functions only)

The scoring functions (`scoreRecallAtK`, `mrr`) are pure and tested without any
DB or model dependency:

```bash
/Users/shwaits/.bun/bin/bun test tests/bench/longmemeval-harness.test.ts
```

Expected: 4 pass / 0 fail.
