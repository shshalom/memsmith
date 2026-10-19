// SPDX-License-Identifier: Apache-2.0
//
// Observation quality eval: llama3.1:8b vs Claude.
//
// Answers the post-ship question from the Ollama work: are llama's observations
// as GOOD as Claude's, not just as well-formed? Generates an observation from
// BOTH providers for the same events, then scores each one BLIND against a
// 5-dimension rubric using a Claude Opus judge (the judge never learns which
// model produced the observation, and never sees the two paired).
//
// Design: docs/superpowers/specs/2026-07-06-observation-quality-eval-design.md
//
// Judge bias caveat: the judge is a Claude-family model scoring (among others)
// Claude's own output. Independent blind scoring is the standard mitigation, but
// a residual self-preference is possible — the report labels this.
//
// Usage (requires a running Ollama with llama3.1:8b, and ANTHROPIC_API_KEY):
//   ollama serve  &&  ollama pull llama3.1:8b
//   ANTHROPIC_API_KEY=... bun bench/quality-eval/eval.ts
//
// Options (env):
//   MEMSMITH_SERVER_MODEL          llama model (default llama3.1:8b)
//   MEMSMITH_OLLAMA_URL            ollama base (default http://localhost:11434/v1)
//   MEMSMITH_QUALITY_ITERATIONS    repeat the corpus N times (default 1)
//   MEMSMITH_QUALITY_CLAUDE_MODEL  Claude baseline model (default DEFAULT_SERVER_CLAUDE_MODEL)
//   MEMSMITH_QUALITY_JUDGE_MODEL   judge model (default claude-opus-4-8)

import { writeFileSync } from 'fs';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { OllamaObservationProvider } from '../../src/server/generation/providers/OllamaObservationProvider.js';
import { ClaudeObservationProvider } from '../../src/server/generation/providers/ClaudeObservationProvider.js';
import type { ServerGenerationContext } from '../../src/server/generation/providers/shared/types.js';
import { EVENT_PAYLOADS, makeContext } from './corpus.js';
import { DIMENSIONS, isSkip, judgeSkip, scoreObservation, type Dimension, type Judge, type Scores, type SkipVerdict } from './judge.js';

const JUDGE_MODEL = process.env.MEMSMITH_QUALITY_JUDGE_MODEL ?? 'claude-opus-4-8';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required for the quality eval (Claude baseline + judge).`);
    process.exit(1);
  }
  return v;
}

interface GenResult { rawText: string; parsed: boolean; error?: string }

async function generate(
  provider: { generate: (c: ServerGenerationContext) => Promise<{ rawText: string }> },
  ctx: ServerGenerationContext,
): Promise<GenResult> {
  try {
    const { rawText } = await provider.generate(ctx);
    return { rawText, parsed: parseAgentXml(rawText).valid };
  } catch (err) {
    return { rawText: '', parsed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface Row {
  label: string;
  model: 'llama' | 'claude';
  rawText: string;
  parsed: boolean;
  skipped: boolean;
  genError?: string;
  scores?: Scores;          // set only for written (non-skip) observations
  skipVerdict?: SkipVerdict; // set only for skips
  scoreError?: string;
}

function mean(nums: number[]): number { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN; }
function fmt(n: number): string { return Number.isNaN(n) ? ' n/a ' : n.toFixed(2); }

async function main(): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const judge: Judge = { provider: 'anthropic', model: JUDGE_MODEL, apiKey };
  ModeManager.getInstance().loadMode('code');

  const llamaModel = process.env.MEMSMITH_SERVER_MODEL ?? 'llama3.1:8b';
  const claudeModel = process.env.MEMSMITH_QUALITY_CLAUDE_MODEL;
  const iterations = Math.max(1, Math.trunc(Number(process.env.MEMSMITH_QUALITY_ITERATIONS ?? 1)) || 1);

  const llama = new OllamaObservationProvider({
    model: llamaModel,
    ...(process.env.MEMSMITH_OLLAMA_URL ? { baseUrl: process.env.MEMSMITH_OLLAMA_URL } : {}),
  });
  const claude = new ClaudeObservationProvider({ apiKey, ...(claudeModel ? { model: claudeModel } : {}) });

  console.log(`\nObservation quality — llama (${llamaModel}) vs claude (${claudeModel ?? 'default'})`);
  console.log(`Blind rubric judge: ${JUDGE_MODEL}. Corpus: ${EVENT_PAYLOADS.length} events × ${iterations}\n`);

  const rows: Row[] = [];
  for (let i = 0; i < iterations; i++) {
    for (const e of EVENT_PAYLOADS) {
      // Same event → both providers (fresh context each; only the id differs).
      const llamaGen = await generate(llama, makeContext(e.payload, e.eventType));
      const claudeGen = await generate(claude, makeContext(e.payload, e.eventType));

      for (const [model, gen] of [['llama', llamaGen], ['claude', claudeGen]] as const) {
        const skipped = !gen.error && isSkip(gen.rawText);
        const row: Row = { label: e.label, model, rawText: gen.rawText, parsed: gen.parsed, skipped, genError: gen.error };
        if (!gen.error) {
          if (skipped) {
            // Separate axis — was skipping the right call for this event?
            const verdict = await judgeSkip(judge, JSON.stringify(e.payload, null, 2));
            if ('error' in verdict) row.scoreError = verdict.error;
            else row.skipVerdict = verdict;
          } else {
            const scored = await scoreObservation(judge, JSON.stringify(e.payload, null, 2), gen.rawText);
            if ('error' in scored) row.scoreError = scored.error;
            else row.scores = scored;
          }
        }
        rows.push(row);
      }
      const tag = (g: GenResult) => g.error ? 'GEN-ERR' : isSkip(g.rawText) ? 'skip' : g.parsed ? 'ok' : 'unparsed';
      console.log(`  [${String(i + 1).padStart(2)}] ${e.label.padEnd(22)} llama:${tag(llamaGen).padEnd(8)} claude:${tag(claudeGen)}`);
    }
  }

  // Aggregate scored rows per model per dimension.
  const scored = rows.filter(r => r.scores);
  const perModel = (m: 'llama' | 'claude') => scored.filter(r => r.model === m);
  // Total non-errored events attempted per model (written + skipped).
  const perModelTotal = (m: 'llama' | 'claude') => rows.filter(r => r.model === m && !r.genError).length;
  const dimMean = (m: 'llama' | 'claude', d: Dimension) => mean(perModel(m).map(r => r.scores![d]));
  const overall = (m: 'llama' | 'claude') => mean(perModel(m).flatMap(r => DIMENSIONS.map(d => r.scores![d])));

  console.log(`\n── Observation quality (1-5, WRITTEN observations only — skips excluded, not scored) ──`);
  console.log(`     ${perModel('llama').length} llama, ${perModel('claude').length} claude observations scored`);
  console.log(`  ${'Dimension'.padEnd(18)} ${'llama'.padStart(6)} ${'claude'.padStart(7)} ${'gap'.padStart(7)}`);
  for (const d of DIMENSIONS) {
    const l = dimMean('llama', d), c = dimMean('claude', d);
    const gap = Number.isNaN(l) || Number.isNaN(c) ? NaN : l - c;
    console.log(`  ${d.padEnd(18)} ${fmt(l).padStart(6)} ${fmt(c).padStart(7)} ${(gap >= 0 ? '+' : '') + fmt(gap)}`.padStart(0));
  }
  const lo = overall('llama'), co = overall('claude');
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  ${'OVERALL'.padEnd(18)} ${fmt(lo).padStart(6)} ${fmt(co).padStart(7)} ${((lo - co) >= 0 ? '+' : '') + fmt(lo - co)}`);

  // Skip axis — how often each model skipped, and whether the judge deemed it appropriate.
  const skipsOf = (m: 'llama' | 'claude') => rows.filter(r => r.model === m && r.skipped);
  const skipRow = (m: 'llama' | 'claude') => {
    const sk = skipsOf(m);
    const judged = sk.filter(r => r.skipVerdict);
    const good = judged.filter(r => r.skipVerdict!.appropriate).length;
    return { n: sk.length, judged: judged.length, good };
  };
  const ls = skipRow('llama'), cs2 = skipRow('claude');
  console.log(`\n── Skip judgment (separate axis — a correct skip is good behavior, not a failure) ──`);
  console.log(`  llama : skipped ${ls.n}/${perModelTotal('llama')} events; ${ls.good}/${ls.judged} judged an APPROPRIATE skip`);
  console.log(`  claude: skipped ${cs2.n}/${perModelTotal('claude')} events; ${cs2.good}/${cs2.judged} judged an APPROPRIATE skip`);

  const parseFail = (m: 'llama' | 'claude') => rows.filter(r => r.model === m && !r.parsed && !r.genError).length;
  const genErr = (m: 'llama' | 'claude') => rows.filter(r => r.model === m && r.genError).length;
  const scoreErr = rows.filter(r => r.scoreError).length;
  console.log(`\n  Parse failures: llama ${parseFail('llama')}, claude ${parseFail('claude')}`);
  console.log(`  Generation errors: llama ${genErr('llama')}, claude ${genErr('claude')}`);
  if (scoreErr) console.log(`  Judge scoring errors (excluded): ${scoreErr}`);
  console.log(`\n  CAVEAT: judged by ${JUDGE_MODEL} (a Claude-family model) — may modestly favor Claude.`);
  console.log(`  Small sample (directional, not statistical proof). Measures quality on this corpus/prompt.\n`);

  // Dump full detail for manual inspection.
  const detail = rows.map(r => ({
    label: r.label, model: r.model, parsed: r.parsed, skipped: r.skipped,
    genError: r.genError ?? null, scoreError: r.scoreError ?? null,
    scores: r.scores ?? null, skipVerdict: r.skipVerdict ?? null, rawText: r.rawText,
  }));
  const outPath = new URL('./last-run.json', import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(detail, null, 2));
  console.log(`  Full per-observation detail written to ${outPath}\n`);
}

main().catch(err => {
  console.error('quality eval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
