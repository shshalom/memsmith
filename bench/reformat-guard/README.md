# Reformat-guard stress harness

Measures how often a generation provider produces output that `parseAgentXml`
accepts, and how much the bounded reformat guard rescues. This is the post-ship
validation for the Ollama provider + reformat guard
(`docs/superpowers/specs/2026-07-05-ollama-provider-format-guard-design.md`):
run it against a real model to decide whether the default retry bound (`1`) is
enough or whether a heavier repair path is warranted.

It drives the **real** `provider.generate()` and the **real** `parseAgentXml`,
and replicates the exact guard loop from
`ProviderObservationGenerator.generateAndPersist`. No Postgres or job pipeline
is required.

## Prerequisites

Default provider is local Ollama. Start it and pull the model first:

```bash
ollama serve            # in one terminal
ollama pull llama3.1:8b
```

## Run

```bash
bun bench/reformat-guard/stress.ts
```

## Options (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `MEMSMITH_STRESS_PROVIDER` | `ollama` | `ollama` \| `openrouter` \| `claude` \| `gemini` |
| `MEMSMITH_SERVER_MODEL` | provider default (`llama3.1:8b` for ollama) | model id override |
| `MEMSMITH_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama base URL |
| `MEMSMITH_STRESS_ITERATIONS` | `1` | repeat the 10-event corpus N times |
| `MEMSMITH_STRESS_MAX_REFORMAT` | `1` | guard bound to test (clamped 0–3) |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | — | for the cloud providers |

Examples:

```bash
# Bigger sample, default guard:
MEMSMITH_STRESS_ITERATIONS=5 bun bench/reformat-guard/stress.ts

# Compare guard OFF vs ON on the same model — run twice and diff the report:
MEMSMITH_STRESS_MAX_REFORMAT=0 MEMSMITH_STRESS_ITERATIONS=5 bun bench/reformat-guard/stress.ts
MEMSMITH_STRESS_MAX_REFORMAT=1 MEMSMITH_STRESS_ITERATIONS=5 bun bench/reformat-guard/stress.ts

# Try a stronger local model:
MEMSMITH_SERVER_MODEL=qwen2.5:14b bun bench/reformat-guard/stress.ts
```

## Reading the output

- **First-shot valid** — the fraction that parsed on the first `generate()`. This
  is what you'd ship with `MEMSMITH_REFORMAT_RETRIES=0` (guard off).
- **Rescued by reformat guard** — invalid first, then a strict re-prompt parsed.
- **Final valid** — valid after the full guard loop (what ships with the guard on).
- **Still invalid after guard** — failed even after retries → these become
  `parse_error` → job failed in production.
- **Avg provider calls/trial** — `1.00` means the guard never fired; higher means
  malformed output triggered re-prompts (extra latency, and extra billed calls
  on cloud providers).

**Decision rule:** a large First-shot→Final gap means the guard earns its keep at
`maxReformat=1`. A low Final-valid even with the guard means `llama3.1:8b` needs a
higher retry bound, a stronger model, or the dedicated-repair path (spec §Out of
scope). Provider errors (network/rate-limit) are reported separately and excluded
from the format rates — they are not format failures.
