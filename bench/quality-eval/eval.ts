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
//   CLAUDE_MEM_SERVER_MODEL          llama model (default llama3.1:8b)
//   CLAUDE_MEM_OLLAMA_URL            ollama base (default http://localhost:11434/v1)
//   CLAUDE_MEM_QUALITY_ITERATIONS    repeat the corpus N times (default 1)
//   CLAUDE_MEM_QUALITY_CLAUDE_MODEL  Claude baseline model (default DEFAULT_SERVER_CLAUDE_MODEL)
//   CLAUDE_MEM_QUALITY_JUDGE_MODEL   judge model (default claude-opus-4-8)

import { writeFileSync } from 'fs';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { OllamaObservationProvider } from '../../src/server/generation/providers/OllamaObservationProvider.js';
import { ClaudeObservationProvider } from '../../src/server/generation/providers/ClaudeObservationProvider.js';
import type { ServerGenerationContext } from '../../src/server/generation/providers/shared/types.js';
import { EVENT_PAYLOADS, makeContext } from './corpus.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const JUDGE_MODEL = process.env.CLAUDE_MEM_QUALITY_JUDGE_MODEL ?? 'claude-opus-4-8';

const DIMENSIONS = ['faithfulness', 'specificity', 'typeCorrectness', 'usefulness', 'structure'] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Scores = Record<Dimension, number> & { rationale: string };

const RUBRIC = `You are grading a single "observation" — a structured memory record an AI coding
assistant generated to summarize one agent event, so a FUTURE session can recall it.
You are given the SOURCE EVENT and the OBSERVATION. Score the observation 1-5 on each
dimension (1 = poor, 5 = excellent). Judge ONLY the observation against the source; you
are NOT told which model wrote it and there is no other observation to compare against.

Dimensions:
- faithfulness: accurately reflects the source event; invents no facts not supported by it.
- specificity: concrete, specific facts rather than vague/generic statements.
- typeCorrectness: the observation's <type> (discovery/decision/bugfix/progress/blocker/etc.) fits the event.
- usefulness: would genuinely help a future session recall or act on this.
- structure: uses the observation schema fields well (title, facts, why, narrative as appropriate).

Return ONLY a JSON object with integer scores 1-5 for each dimension and a one-sentence rationale.`;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    faithfulness: { type: 'integer' },
    specificity: { type: 'integer' },
    typeCorrectness: { type: 'integer' },
    usefulness: { type: 'integer' },
    structure: { type: 'integer' },
    rationale: { type: 'string' },
  },
  required: ['faithfulness', 'specificity', 'typeCorrectness', 'usefulness', 'structure', 'rationale'],
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required for the quality eval (Claude baseline + judge).`);
    process.exit(1);
  }
  return v;
}

/** Blind rubric score for one observation. Raw fetch, mirroring ClaudeObservationProvider. */
async function scoreObservation(
  apiKey: string,
  event: unknown,
  observationText: string,
): Promise<Scores | { error: string }> {
  const prompt = [
    RUBRIC,
    '',
    '<source_event>',
    JSON.stringify(event, null, 2),
    '</source_event>',
    '',
    '<observation>',
    observationText || '(empty — the model returned nothing)',
    '</observation>',
  ].join('\n');

  const attempt = async (): Promise<Scores> => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    const text = data.content?.find(b => b.type === 'text')?.text ?? '';
    return JSON.parse(text) as Scores;
  };

  try {
    return await attempt();
  } catch {
    try { return await attempt(); } // one retry on transient/JSON hiccup
    catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
  }
}

// A <skip_summary/> is a distinct outcome, not a bad observation. The model
// decided the event isn't worth recording. Scoring that on the 5-dim rubric
// (empty content → 1s) wrongly punishes a CORRECT skip, so we judge skips on a
// separate axis: was skipping appropriate for THIS event?
type SkipVerdict = { appropriate: boolean; rationale: string };

const SKIP_RUBRIC = `An AI coding assistant chose NOT to record a memory observation for the agent
event below — it emitted a "skip" instead of an observation. Decide whether
skipping was APPROPRIATE. Skipping is appropriate when the event is trivial,
routine, or contains nothing a future session would benefit from remembering
(e.g. "ls", "echo hi", a plain file read). Skipping is INAPPROPRIATE when the
event contains a durable, useful fact worth recording (a decision, a bugfix, a
non-obvious discovery). You are not told which model made this choice.

Return ONLY a JSON object: {"appropriate": true|false, "rationale": "one sentence"}.`;

const SKIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { appropriate: { type: 'boolean' }, rationale: { type: 'string' } },
  required: ['appropriate', 'rationale'],
};

async function judgeSkip(apiKey: string, event: unknown): Promise<SkipVerdict | { error: string }> {
  const prompt = [SKIP_RUBRIC, '', '<source_event>', JSON.stringify(event, null, 2), '</source_event>'].join('\n');
  const attempt = async (): Promise<SkipVerdict> => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 512,
        output_config: { format: { type: 'json_schema', schema: SKIP_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return JSON.parse(data.content?.find(b => b.type === 'text')?.text ?? '') as SkipVerdict;
  };
  try { return await attempt(); }
  catch { try { return await attempt(); } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; } }
}

/** A skip is any parsed output whose only content is a <skip_summary> marker. */
function isSkip(rawText: string): boolean {
  return /<skip_summary[\s/>]/.test(rawText) && !/<observation[\s>]/.test(rawText);
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
  ModeManager.getInstance().loadMode('code');

  const llamaModel = process.env.CLAUDE_MEM_SERVER_MODEL ?? 'llama3.1:8b';
  const claudeModel = process.env.CLAUDE_MEM_QUALITY_CLAUDE_MODEL;
  const iterations = Math.max(1, Math.trunc(Number(process.env.CLAUDE_MEM_QUALITY_ITERATIONS ?? 1)) || 1);

  const llama = new OllamaObservationProvider({
    model: llamaModel,
    ...(process.env.CLAUDE_MEM_OLLAMA_URL ? { baseUrl: process.env.CLAUDE_MEM_OLLAMA_URL } : {}),
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
            const verdict = await judgeSkip(apiKey, e.payload);
            if ('error' in verdict) row.scoreError = verdict.error;
            else row.skipVerdict = verdict;
          } else {
            const scored = await scoreObservation(apiKey, e.payload, gen.rawText);
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
