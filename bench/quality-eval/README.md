# Observation quality eval — llama3.1:8b vs Claude

Answers the post-ship question from the Ollama work: are `llama3.1:8b`'s
observations as **good** as Claude's, not just as well-formed? (The reformat-guard
stress test already showed llama formats perfectly; this measures quality.)

Method: generate an observation from **both** providers for the same events, then
score each one **blind** against a 5-dimension rubric using a Claude Opus judge.
The judge never learns which model produced the observation and never sees the two
paired. Design: `docs/superpowers/specs/2026-07-06-observation-quality-eval-design.md`.

## Prerequisites

- A running Ollama with the model pulled (`ollama serve` && `ollama pull llama3.1:8b`).
- `ANTHROPIC_API_KEY` set (used for the Claude baseline **and** the judge).

## Run

```bash
ANTHROPIC_API_KEY=... bun bench/quality-eval/eval.ts
```

## Options (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | — | **Required** — Claude baseline + judge |
| `MEMSMITH_SERVER_MODEL` | `llama3.1:8b` | local model to evaluate |
| `MEMSMITH_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama base URL |
| `MEMSMITH_QUALITY_ITERATIONS` | `1` | repeat the 10-event corpus N times for a bigger sample |
| `MEMSMITH_QUALITY_CLAUDE_MODEL` | provider default | Claude baseline model override |
| `MEMSMITH_QUALITY_JUDGE_MODEL` | `claude-opus-4-8` | judge model override |

## Output

A per-dimension table (llama avg, Claude avg, gap) on a 1–5 scale, plus overall,
parse/generation/judge error counts, and `bench/quality-eval/last-run.json`
(gitignored) with every observation + its per-dimension scores + judge rationale
for manual inspection.

## Rubric (1–5 each)

- **faithfulness** — accurately reflects the source event; invents nothing.
- **specificity** — concrete facts, not vague/generic.
- **typeCorrectness** — the `<type>` fits the event.
- **usefulness** — would help a future session recall/act on this.
- **structure** — schema fields (title/facts/why/narrative) used well.

## Caveats (also printed by the run)

- **Claude-family judge** — the judge is Claude scoring (among others) Claude's own
  output; blind independent scoring mitigates but a residual self-preference is
  possible. The true gap may be modestly smaller than reported.
- **Small sample** — 10 events × 1 by default. Directional, not statistical proof;
  raise `MEMSMITH_QUALITY_ITERATIONS` for more.
- Measures quality on **this corpus/prompt**, not all inputs. A larger local model
  (Qwen 2.5, Llama 3.3 70B) would likely close the gap.

## Results (2026-07-06, corrected two-axis harness, n=10, judge claude-opus-4-8)

The harness scores TWO axes: (1) observation quality on WRITTEN observations
(skips excluded — a `<skip_summary/>` is judged separately, not scored 1.0), and
(2) skip judgment (was skipping appropriate for the event?).

**Axis 1 — observation quality (1-5, written observations only):**

| Model | overall | vs Claude |
|---|---|---|
| qwen2.5:14b | **4.24** | +0.04 (ties Claude) |
| Claude (baseline) | ~4.0-4.2 | — |
| llama3.1:8b | 2.90 | -1.08 (clearly behind) |

**Axis 2 — skip judgment:**

| Model | skipped | appropriate skips |
|---|---|---|
| qwen2.5:14b | 5/10 | 4/5 |
| Claude | 1/10 | 1/1 |
| llama3.1:8b | 0/10 | n/a (never skips) |

Read: **qwen2.5:14b ties Claude on written-observation quality** and skips trivial
events well (like `echo hi`) — arguably ideal memory behavior. **llama3.1:8b lags
on both axes**: worse observations AND never knows when to stay quiet (writes
mediocre records for trivia). 0 parse/generation errors for all models.

METHODOLOGY NOTE: an earlier version scored `<skip_summary/>` as 1.0 on all
dimensions, which wrongly punished correct skips and made qwen look ~1pt worse
than it is. The current harness fixes this by judging skips on a separate axis.
Caveats unchanged: Claude-family judge (qwen tying it anyway strengthens the
result), n=10 is directional with demonstrated ±0.1-0.2 judge noise.
