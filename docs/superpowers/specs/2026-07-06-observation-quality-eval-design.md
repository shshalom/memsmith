# Observation Quality Eval: llama3.1:8b vs Claude — Design

**Date:** 2026-07-06
**Status:** Approved (architecture); ready for implementation plan
**Area:** `bench/quality-eval/` (dev harness — not shipped code)

## Goal

Answer the open question from the Ollama post-ship validation: are
`llama3.1:8b`'s observations **as good as** Claude's, not just as well-formed?
The stress test already proved llama produces parse-valid XML 100% of the time;
this measures the *quality* of the summaries it produces, against Claude as the
baseline, on the same events.

## Method (decided during brainstorming)

- **Rubric-scored LLM-as-judge**, blind and independent (not pairwise).
- **5 rubric dimensions**, each scored 1–5:
  1. **Faithfulness** — accurately reflects the source event; invents nothing.
  2. **Specificity** — concrete facts, not vague/generic.
  3. **Type correctness** — the `<type>` (discovery/decision/bugfix/etc.) fits the event.
  4. **Usefulness** — would help a future session recall/act on this.
  5. **Structure** — schema fields (title/facts/why/narrative) used well.
- **Judge:** Claude Opus (`claude-opus-4-8`).
- **Bias control:** the judge scores each observation **alone**, against the
  rubric only, **never told which model produced it** and **never shown the two
  paired**. This removes the "pick my sibling" pull of pairwise comparison.
  Residual Claude-family self-preference is accepted and labeled in the report.

## Architecture & data flow

New harness `bench/quality-eval/eval.ts`, mirroring `bench/reformat-guard/stress.ts`.
Per event in the corpus:

1. **Generate from both providers** — same event context, same prompt (the
   shared `buildServerGenerationPrompt`), same temperature (0.3), through
   `OllamaObservationProvider` (llama3.1:8b) and `ClaudeObservationProvider`
   (via `ANTHROPIC_API_KEY`). Capture both raw observations.
2. **Parse both** — `parseAgentXml`. A parse failure is recorded (structure=1,
   flagged) rather than crashing; other dims still scored on the raw text so a
   malformed-but-informative observation isn't silently dropped.
3. **Blind independent scoring** — for EACH observation separately, send
   `{ source event, observation text, rubric }` to the judge. The judge returns
   `{ faithfulness, specificity, typeCorrectness, usefulness, structure, rationale }`.
   The observation is presented as "an observation" — no model label. Scored one
   at a time; the two are never in the same judge call.
4. **Aggregate** — per-dimension average for llama vs Claude across the corpus +
   overall average. Report the gap per dimension.

## Components (small, focused)

- **`bench/quality-eval/corpus.ts`** — the shared event corpus (10 varied events:
  bash, edit, decision, bugfix, read, grep, trivial, blocker, refactor, prompt).
  Extract from `bench/reformat-guard/stress.ts`'s `EVENT_PAYLOADS` into this
  module and have the stress harness import it too (one source of truth; DRY).
- **`makeContext(payload, eventType)`** — builds a `ServerGenerationContext` with
  a synthetic in-memory event/job (no DB), same as the stress harness. Move to
  `corpus.ts` alongside the events.
- **`generateObservation(provider, ctx)`** — `provider.generate(ctx)` →
  `{ rawText, parsed: boolean }` (parsed = `parseAgentXml(rawText).valid`).
- **`scoreObservation(event, observationText)`** — the blind rubric judge call.
  Uses the Claude Opus provider directly (a `client.messages` call with a
  structured-output/JSON schema so the five 1–5 scores + rationale always parse).
  Returns the score object. NO model label in the prompt.
- **`main()`** — orchestrates generate→score for both providers over the corpus,
  aggregates, prints the comparison table, dumps per-observation detail to a file.

## Judge prompt (owned by implementer, but the contract)

The judge receives: the source event (as the provider saw it), one observation's
raw text, and the 5-dimension rubric with explicit 1–5 anchors. It must return
JSON: `{faithfulness, specificity, typeCorrectness, usefulness, structure, rationale}`,
each score an integer 1–5. No comparison, no other observation, no source-model
identity. Temperature 0 for the judge (scoring should be deterministic-ish).

**Implementation note — verify the current Anthropic SDK shape.** The judge call
is a direct Anthropic API call (not through the ServerGenerationProvider layer —
those build the observation-generation prompt, not a scoring prompt). The
2025–2026 API has drift (structured output via `output_config.format`, not the
deprecated `output_format`; adaptive thinking; `claude-opus-4-8` id). The
implementer MUST consult the `claude-api` skill / reference for the exact current
`@anthropic-ai/sdk` call shape rather than write it from memory. A plain
`messages.create` with a JSON-only instruction + a strict parse (retry once on
malformed judge JSON) is acceptable if structured-output setup is heavier than
warranted for a bench tool — implementer's call, but grounded in the reference.

## Output

```
Observation quality — llama3.1:8b vs claude (blind rubric judge: claude-opus-4-8)
Corpus: 10 events

Dimension          llama   claude   gap
Faithfulness        x.x     x.x    +/-x.x
Specificity         x.x     x.x    ...
Type correctness    ...
Usefulness          ...
Structure           ...
────────────────────────────────────
Overall             x.x     x.x    +/-x.x

Parse failures: llama N, claude N
```
Plus a `bench/quality-eval/last-run.md` (gitignored) with every observation +
its per-dimension scores + the judge's rationale, for manual inspection.

## Config (env)

- `ANTHROPIC_API_KEY` — required (Claude baseline + the judge).
- `CLAUDE_MEM_SERVER_MODEL` — llama model override (default `llama3.1:8b`).
- `CLAUDE_MEM_OLLAMA_URL` — ollama base (default `http://localhost:11434/v1`).
- `CLAUDE_MEM_QUALITY_ITERATIONS` — repeat the corpus N times for a bigger
  sample (default 1). Judge/gen calls scale linearly.
- `CLAUDE_MEM_QUALITY_JUDGE_MODEL` — judge model override (default `claude-opus-4-8`).

## Error handling

- A provider throw (network/rate-limit) on generation → record the event as a
  generation error for that model, exclude from that model's averages, continue.
- A judge throw → retry once; if it still fails, mark that observation unscored
  and exclude from averages (reported in the failure summary). Never crash the run.
- Ollama unreachable → the harness surfaces the connection error clearly (same
  as the stress harness) and exits non-zero.

## Testing

This is a bench utility, not shipped code — validated by running it, not a unit
suite. Sanity checks the implementer runs:
- Judge returns well-formed scores (schema-validated) for a hand-crafted good and
  bad observation, and scores the bad one lower — confirms the judge discriminates.
- The corpus extraction leaves the stress harness still passing (import swap only).

## Honest scope / caveats (must appear in the report)

- **Small sample** (10 events × 1 = 10 obs/model by default). Directional, not a
  statistical proof. Bump with `CLAUDE_MEM_QUALITY_ITERATIONS` for more.
- **Claude-family judge** → residual self-preference bias; report says so.
- Measures quality on THIS corpus/prompt, not all inputs.
- Judge scores are model opinion, not ground truth — treat as a signal.

## Out of scope (YAGNI)

- Pairwise/win-rate scoring (we chose independent rubric scoring).
- A second (Gemini) judge (can add later if the numbers are close and it matters).
- Wiring any of this into the shipped product or CI — it's a one-off/occasional
  dev measurement.
- Judging retrieval quality (that's LongMemEval/R@5 — separate and already done).
