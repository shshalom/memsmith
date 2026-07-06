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
| `CLAUDE_MEM_SERVER_MODEL` | `llama3.1:8b` | local model to evaluate |
| `CLAUDE_MEM_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama base URL |
| `CLAUDE_MEM_QUALITY_ITERATIONS` | `1` | repeat the 10-event corpus N times for a bigger sample |
| `CLAUDE_MEM_QUALITY_CLAUDE_MODEL` | provider default | Claude baseline model override |
| `CLAUDE_MEM_QUALITY_JUDGE_MODEL` | `claude-opus-4-8` | judge model override |

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
  raise `CLAUDE_MEM_QUALITY_ITERATIONS` for more.
- Measures quality on **this corpus/prompt**, not all inputs. A larger local model
  (Qwen 2.5, Llama 3.3 70B) would likely close the gap.

## 2026-07-06 baseline result (n=10, judge claude-opus-4-8)

| Dimension | llama3.1:8b | Claude | gap |
|---|---|---|---|
| faithfulness | 3.00 | 3.80 | −0.80 |
| specificity | 3.00 | 3.90 | −0.90 |
| typeCorrectness | 2.70 | 3.90 | −1.20 |
| usefulness | 2.60 | 3.70 | −1.10 |
| structure | 3.00 | 4.20 | −1.20 |
| **overall** | **2.86** | **3.90** | **−1.04** |

Read: llama is ~1 point worse overall but **ties Claude on rich, explicit events**
(a clear decision/bugfix both scored ~5); the gap is concentrated on terse/ambiguous
events and occasional minor hallucination. 0 parse/generation errors on both sides —
a quality gap, not a format gap.
