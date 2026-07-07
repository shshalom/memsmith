// SPDX-License-Identifier: Apache-2.0
//
// Reformat-guard stress harness.
//
// Measures how often a generation provider (default: local Ollama /
// llama3.1:8b) produces output that parseAgentXml accepts, and how much the
// bounded reformat guard rescues. This is the post-ship validation referenced
// in docs/superpowers/specs/2026-07-05-ollama-provider-format-guard-design.md:
// run it against a real model to decide whether the default retry bound (1) is
// enough or whether a heavier repair path is warranted.
//
// It exercises the REAL provider.generate() and the REAL parseAgentXml, and
// replicates the exact guard loop from ProviderObservationGenerator.generate-
// AndPersist (the guard logic itself is private to that method, so we mirror
// it here; describeParseFailure/reformatRetryLimit are re-implemented to match).
// No Postgres or job pipeline is needed — the provider only reads context
// fields to build the prompt, and the parser is what judges the output.
//
// Usage:
//   # Ollama must be running locally with the model pulled:
//   #   ollama serve   &&   ollama pull llama3.1:8b
//   bun bench/reformat-guard/stress.ts
//
//   # Options (env):
//   MEMSMITH_STRESS_PROVIDER=ollama|openrouter|claude|gemini  (default ollama)
//   MEMSMITH_SERVER_MODEL=llama3.1:8b                          (provider model override)
//   MEMSMITH_OLLAMA_URL=http://localhost:11434/v1             (ollama base url)
//   MEMSMITH_STRESS_ITERATIONS=3                              (repeat the corpus N times; default 1)
//   MEMSMITH_STRESS_MAX_REFORMAT=1                            (guard bound to test; default 1, clamp 0-3)
//   OPENROUTER_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY    (for the cloud providers)

import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { OllamaObservationProvider } from '../../src/server/generation/providers/OllamaObservationProvider.js';
import { OpenRouterObservationProvider } from '../../src/server/generation/providers/OpenRouterObservationProvider.js';
import { ClaudeObservationProvider } from '../../src/server/generation/providers/ClaudeObservationProvider.js';
import { GeminiObservationProvider } from '../../src/server/generation/providers/GeminiObservationProvider.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
} from '../../src/server/generation/providers/shared/types.js';
// Shared event corpus + context builder (one source of truth for both benches).
import { EVENT_PAYLOADS, makeContext } from '../quality-eval/corpus.js';

// Mirror of the private describeParseFailure in ProviderObservationGenerator.
function describeParseFailure(rawText: string): string {
  const t = rawText.trim();
  if (t.length === 0) return 'empty response';
  if (!/<observation[\s>]/.test(t) && !/<summary[\s>]/.test(t) && !/<skip_summary/.test(t)) {
    return 'no <observation> block found';
  }
  return 'the XML observation block was malformed or empty';
}

function clampReformat(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, Math.min(3, Math.trunc(raw)));
}

function buildProvider(): ServerGenerationProvider {
  const kind = (process.env.MEMSMITH_STRESS_PROVIDER ?? 'ollama').trim().toLowerCase();
  const model = process.env.MEMSMITH_SERVER_MODEL;
  if (kind === 'ollama') {
    const opts: { model?: string; baseUrl?: string; apiKey?: string } = {};
    opts.model = model ?? 'llama3.1:8b';
    if (process.env.MEMSMITH_OLLAMA_URL) opts.baseUrl = process.env.MEMSMITH_OLLAMA_URL;
    if (process.env.MEMSMITH_OLLAMA_API_KEY) opts.apiKey = process.env.MEMSMITH_OLLAMA_API_KEY;
    return new OllamaObservationProvider(opts);
  }
  if (kind === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey) throw new Error('OPENROUTER_API_KEY required for provider=openrouter');
    const opts: { apiKey: string; model?: string; baseUrl?: string } = { apiKey };
    if (model) opts.model = model;
    if (process.env.MEMSMITH_OPENROUTER_BASE_URL) opts.baseUrl = process.env.MEMSMITH_OPENROUTER_BASE_URL;
    return new OpenRouterObservationProvider(opts);
  }
  if (kind === 'claude' || kind === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for provider=claude');
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (model) opts.model = model;
    return new ClaudeObservationProvider(opts);
  }
  if (kind === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY ?? '';
    if (!apiKey) throw new Error('GEMINI_API_KEY required for provider=gemini');
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (model) opts.model = model;
    return new GeminiObservationProvider(opts);
  }
  throw new Error(`Unknown MEMSMITH_STRESS_PROVIDER: ${kind}`);
}

interface Trial {
  label: string;
  firstShotValid: boolean;     // did the very first generate() parse?
  rescued: boolean;            // invalid first, then a reformat retry parsed
  finalValid: boolean;         // valid after the full guard loop
  calls: number;               // provider calls used (1 + reformat attempts)
  skip: boolean;               // final valid output was a <skip_summary/>
  error?: string;              // provider threw (network/rate limit) — not a format failure
}

async function runOne(
  provider: ServerGenerationProvider,
  label: string,
  ctx: ServerGenerationContext,
  maxReformat: number,
): Promise<Trial> {
  let calls = 0;
  try {
    let result = await provider.generate(ctx);
    calls++;
    const firstShotValid = parseAgentXml(result.rawText).valid;
    let finalValid = firstShotValid;
    for (let attempt = 0; attempt < maxReformat; attempt++) {
      if (parseAgentXml(result.rawText).valid) break;
      const reformatReason = describeParseFailure(result.rawText);
      result = await provider.generate(ctx, undefined, { reformatReason });
      calls++;
      finalValid = parseAgentXml(result.rawText).valid;
    }
    const skip = /<skip_summary/.test(result.rawText);
    return {
      label,
      firstShotValid,
      rescued: !firstShotValid && finalValid,
      finalValid,
      calls,
      skip: finalValid && skip,
    };
  } catch (err) {
    // A THROWN provider error is not a format failure — record and continue.
    return { label, firstShotValid: false, rescued: false, finalValid: false, calls, skip: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

async function main(): Promise<void> {
  ModeManager.getInstance().loadMode('code'); // parseAgentXml + prompt builder need an active mode
  const provider = buildProvider();
  const iterations = Math.max(1, Math.trunc(Number(process.env.MEMSMITH_STRESS_ITERATIONS ?? 1)) || 1);
  const maxReformat = clampReformat(Number(process.env.MEMSMITH_STRESS_MAX_REFORMAT ?? 1));
  const providerKind = (process.env.MEMSMITH_STRESS_PROVIDER ?? 'ollama').toLowerCase();

  console.log(`\nReformat-guard stress — provider=${providerKind} model=${process.env.MEMSMITH_SERVER_MODEL ?? '(default)'} iterations=${iterations} maxReformat=${maxReformat}`);
  console.log(`Corpus: ${EVENT_PAYLOADS.length} events × ${iterations} = ${EVENT_PAYLOADS.length * iterations} trials\n`);

  const trials: Trial[] = [];
  for (let i = 0; i < iterations; i++) {
    for (const e of EVENT_PAYLOADS) {
      const t = await runOne(provider, e.label, makeContext(e.payload, e.eventType), maxReformat);
      trials.push(t);
      const mark = t.error ? `ERROR (${t.error.slice(0, 40)})` : t.finalValid ? (t.rescued ? `rescued (${t.calls} calls)` : t.skip ? 'valid/skip' : 'valid') : 'STILL INVALID';
      console.log(`  [${String(i + 1).padStart(2)}] ${e.label.padEnd(22)} ${mark}`);
    }
  }

  const errored = trials.filter(t => t.error).length;
  const scored = trials.filter(t => !t.error);
  const firstShot = scored.filter(t => t.firstShotValid).length;
  const rescued = scored.filter(t => t.rescued).length;
  const finalValid = scored.filter(t => t.finalValid).length;
  const stillInvalid = scored.filter(t => !t.finalValid).length;
  const totalCalls = scored.reduce((s, t) => s + t.calls, 0);

  console.log(`\n── Results (${scored.length} scored, ${errored} provider errors excluded) ──`);
  console.log(`  First-shot valid (guard off equivalent): ${firstShot}/${scored.length}  (${pct(firstShot, scored.length)})`);
  console.log(`  Rescued by reformat guard:               ${rescued}/${scored.length}  (${pct(rescued, scored.length)})`);
  console.log(`  Final valid (guard on, maxReformat=${maxReformat}):    ${finalValid}/${scored.length}  (${pct(finalValid, scored.length)})`);
  console.log(`  Still invalid after guard:               ${stillInvalid}/${scored.length}  (${pct(stillInvalid, scored.length)})`);
  console.log(`  Avg provider calls/trial:                ${scored.length ? (totalCalls / scored.length).toFixed(2) : 'n/a'}  (1.00 = guard never fired)`);
  if (errored > 0) {
    console.log(`\n  ${errored} provider error(s) (network/rate-limit — NOT format failures; excluded from rates):`);
    for (const t of trials.filter(x => x.error).slice(0, 5)) console.log(`    - ${t.label}: ${t.error}`);
  }
  console.log(`\nInterpretation: compare "First-shot valid" (what you'd ship with MEMSMITH_REFORMAT_RETRIES=0)`);
  console.log(`vs "Final valid" (with the guard). A large gap = the guard is earning its keep; a low`);
  console.log(`"Final valid" even with the guard = consider a higher retry bound or the repair path.\n`);
}

main().catch(err => {
  console.error('stress harness failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
