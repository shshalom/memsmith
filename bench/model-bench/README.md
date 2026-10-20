# Model bench

This bench compares generation models on the same events with the same production prompt and a blind judge. Use it to decide which model MemSmith runs, given RAM, speed, cost, and observation quality.

## Run the bench

1. Sample real events into the local corpus:

   ```bash
   bun bench/model-bench/sample-events.ts
   ```

2. Run the bench:

   ```bash
   ANTHROPIC_API_KEY=... bun bench/model-bench/bench.ts
   ```

The header of `bench/model-bench/bench.ts` documents the environment options, including the model list, the judge, the Ollama context size, and the phase. Results are cached under `bench/model-bench/results/`, so a rerun does only the missing work.

## Method

- The corpus has 10 synthetic events and 40 real events, stratified by tool.
- Every model receives the production prompt. Local models run through Ollama's native `/api/chat` with a fixed 20,480-token context and thinking off.
- A blind rubric judge scores each observation. The judge doesn't see which model wrote it.
- A model counts as **Usable** on an event when it correctly skips the event or writes an observation that scores 3.5 or higher.

Corpus: 10 synthetic + 40 real events. Local num_ctx 20480.

## Results

### Judge: anthropic:claude-opus-5-5

| Model | Usable | Quality (1-5) | Real-event quality | Faithful | Written | Skips | Bad skips | Parse fail | Errors | p50 latency (s) | p95 latency (s) | RAM (GB) | Disk (GB) | USD per 1k events |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic:claude-haiku-5-5 | **96%** | 4.21 | 4.20 | 4.00 | 40 | 10 | 0 | 0 | 0 | 5.5 | 11.4 | n/a | n/a | $1.042 |
| anthropic:claude-haiku-4-5-20251001 | **72%** | 3.71 | 3.68 | 3.28 | 39 | 11 | 0 | 0 | 0 | 5.4 | 16.0 | n/a | n/a | $6.368 |
| ollama:gemma4:12b | **56%** | 3.43 | 3.35 | 3.22 | 36 | 14 | 2 | 0 | 0 | 26.5 | 57.8 | 9.7 | 8.0 | 0 |
| ollama:qwen3.5:9b | **54%** | 2.96 | 2.76 | 2.27 | 11 | 39 | 15 | 0 | 0 | 3.9 | 27.1 | 6.8 | 6.6 | 0 |
| ollama:qwen2.5:14b | **52%** | 2.69 | 2.42 | 2.38 | 13 | 37 | 12 | 0 | 0 | 8.1 | 57.1 | 12.8 | 9.0 | 0 |

### Cross-check judge: ollama:qwen3.6:27b

A non-Claude local judge scores the same outputs. Claude Haiku 5.5 and Gemma 4 rank first, and the two Qwen models rank last.

| Model | Usable | Quality (1-5) | Real-event quality | Faithful | Written | Skips | Bad skips | Parse fail | Errors | p50 latency (s) | p95 latency (s) | RAM (GB) | Disk (GB) | USD per 1k events |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic:claude-haiku-5-5 | **100%** | 4.91 | 4.93 | 4.90 | 40 | 10 | 0 | 0 | 0 | 5.5 | 11.4 | n/a | n/a | $1.042 |
| ollama:gemma4:12b | **100%** | 4.75 | 4.77 | 4.78 | 36 | 14 | 0 | 0 | 0 | 26.5 | 57.8 | 9.7 | 8.0 | 0 |
| anthropic:claude-haiku-4-5-20251001 | **96%** | 4.68 | 4.74 | 4.46 | 39 | 11 | 0 | 0 | 0 | 5.4 | 16.0 | n/a | n/a | $6.368 |
| ollama:qwen2.5:14b | **86%** | 4.06 | 3.92 | 3.85 | 13 | 37 | 5 | 0 | 0 | 8.1 | 57.1 | 12.8 | 9.0 | 0 |
| ollama:qwen3.5:9b | **80%** | 4.51 | 4.42 | 4.27 | 11 | 39 | 8 | 0 | 0 | 3.9 | 27.1 | 6.8 | 6.6 | 0 |

## Caveats

- The primary judge is from the Claude family. A non-Claude local judge cross-checked the results. The two judges agree on the tiers but swap the order of the two lowest models.
- Local latency was measured under contention from the live MemSmith runtime and other work, so treat local latency as an upper bound.
- Gemma 4 RAM comes from the wired-memory delta, because Ollama's `/api/ps` under-reports it.
- The real-event corpus is gitignored because it holds session data. You must sample your own with `sample-events.ts`, so your numbers differ.
