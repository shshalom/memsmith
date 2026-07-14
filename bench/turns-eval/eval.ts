// SPDX-License-Identifier: Apache-2.0
//
// GAP1 eval — does the SERVER single-shot generation path lose quality vs the
// WORKER multi-turn path? This is the one gap the existing quality-eval does NOT
// cover: quality-eval compares two MODELS on the single-shot path; this compares
// two PATHS (turn structure) on the SAME model, so the only variable is
// single-shot-vs-multi-turn.
//
// Both arms use the SAME Ollama model (default qwen2.5:14b) and the SAME corpus.
//
//   SINGLE-SHOT arm : the real server provider — OllamaObservationProvider.generate()
//                     called once per event (stateless, one LLM call per event).
//   MULTI-TURN  arm : replicates the worker conversation shape using the worker's
//                     own prompt builders (src/sdk/prompts.ts): one init turn, then
//                     one observation turn PER event carrying full conversation
//                     history, exactly as OpenAICompatibleProvider does. Run directly
//                     against Ollama's chat API so no SQLite/SessionManager is needed
//                     (the store is plumbing; the quality variable is the turns+history).
//
// Both arms' per-event observations are blind-judged by a Claude Opus rubric
// (the same 5 dimensions quality-eval uses). The judge never learns which PATH
// produced an observation.
//
// Usage (requires running Ollama + ANTHROPIC_API_KEY):
//   ANTHROPIC_API_KEY=... MEMSMITH_SERVER_MODEL=qwen2.5:14b bun bench/turns-eval/eval.ts
//
// Env:
//   MEMSMITH_SERVER_MODEL   Ollama model for BOTH arms (default qwen2.5:14b)
//   MEMSMITH_OLLAMA_URL     Ollama OpenAI-compat base (default http://localhost:11434/v1)
//   MEMSMITH_TURNS_JUDGE_MODEL   judge (default claude-opus-4-8)

import { writeFileSync } from 'fs';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { buildInitPrompt, buildObservationPrompt } from '../../src/sdk/prompts.js';
import { OllamaObservationProvider } from '../../src/server/generation/providers/OllamaObservationProvider.js';
import { EVENT_PAYLOADS, makeContext } from '../quality-eval/corpus.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const JUDGE_MODEL = process.env.MEMSMITH_TURNS_JUDGE_MODEL ?? 'claude-opus-4-8';
const OLLAMA_MODEL = process.env.MEMSMITH_SERVER_MODEL ?? 'qwen2.5:14b';
const OLLAMA_BASE = process.env.MEMSMITH_OLLAMA_URL ?? 'http://localhost:11434/v1';

const DIMENSIONS = ['faithfulness', 'specificity', 'typeCorrectness', 'usefulness', 'structure'] as const;
type Dimension = (typeof DIMENSIONS)[number];
type Scores = Record<Dimension, number> & { rationale: string };

const RUBRIC = `You are grading a single "observation" — a structured memory record an AI coding
assistant generated to summarize one agent event, so a FUTURE session can recall it.
You are given the SOURCE EVENT and the OBSERVATION. Score the observation 1-5 on each
dimension (1 = poor, 5 = excellent). Judge ONLY the observation against the source; you
are NOT told which method produced it and there is no other observation to compare against.

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
    faithfulness: { type: 'integer' }, specificity: { type: 'integer' },
    typeCorrectness: { type: 'integer' }, usefulness: { type: 'integer' },
    structure: { type: 'integer' }, rationale: { type: 'string' },
  },
  required: ['faithfulness', 'specificity', 'typeCorrectness', 'usefulness', 'structure', 'rationale'],
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} is required (Claude judge).`); process.exit(1); }
  return v;
}

async function judge(apiKey: string, event: unknown, observationText: string): Promise<Scores | { error: string }> {
  const prompt = [
    RUBRIC, '', '<source_event>', JSON.stringify(event, null, 2), '</source_event>', '',
    '<observation>', observationText || '(empty — nothing recorded)', '</observation>',
  ].join('\n');
  const attempt = async (): Promise<Scores> => {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: JUDGE_MODEL, max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return JSON.parse(data.content?.find(b => b.type === 'text')?.text ?? '') as Scores;
  };
  try { return await attempt(); }
  catch { try { return await attempt(); } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; } }
}

// One Ollama chat turn over an OpenAI-compat /chat/completions endpoint.
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
async function ollamaChat(history: ChatMsg[]): Promise<string> {
  const url = OLLAMA_BASE.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ollama-local' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages: history, temperature: 0.2, max_tokens: 2048 }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

// Map a corpus event into the worker's Observation shape (tool_name/input/output),
// so buildObservationPrompt sees what the worker would see. Non-tool events carry
// their content in the input.
function toWorkerObs(eventType: string, payload: any) {
  if (eventType === 'tool_use') {
    return { id: 0, tool_name: String(payload.tool ?? 'Tool'), tool_input: JSON.stringify(payload), tool_output: JSON.stringify(payload.output ?? payload.matches ?? payload.snippet ?? ''), created_at_epoch: 0 };
  }
  return { id: 0, tool_name: eventType, tool_input: JSON.stringify(payload), tool_output: '', created_at_epoch: 0 };
}

interface PerEvent { label: string; text: string; skipped: boolean; parsed: boolean }

// MULTI-TURN arm: one init turn, then one observation turn per event carrying
// the full accumulated history (the worker's OpenAICompatibleProvider shape).
async function runMultiTurn(mode: any): Promise<PerEvent[]> {
  const history: ChatMsg[] = [];
  const init = buildInitPrompt('bench', 'turns-eval-session', 'Observe this coding session and record durable memories.', mode);
  history.push({ role: 'user', content: init });
  const initResp = await ollamaChat(history);
  history.push({ role: 'assistant', content: initResp });

  const out: PerEvent[] = [];
  for (const e of EVENT_PAYLOADS) {
    const obs = toWorkerObs(e.eventType, e.payload as any);
    const prompt = buildObservationPrompt(obs);
    history.push({ role: 'user', content: prompt });
    const resp = await ollamaChat(history);
    history.push({ role: 'assistant', content: resp });
    const parsed = parseAgentXml(resp);
    const skipped = !/<observation[\s>]/.test(resp);
    out.push({ label: e.label, text: resp, skipped, parsed: parsed.valid });
  }
  return out;
}

// SINGLE-SHOT arm: the real server provider, once per event (stateless).
async function runSingleShot(): Promise<PerEvent[]> {
  const provider = new OllamaObservationProvider({ model: OLLAMA_MODEL, baseUrl: OLLAMA_BASE });
  const out: PerEvent[] = [];
  for (const e of EVENT_PAYLOADS) {
    let text = '';
    try { text = (await provider.generate(makeContext(e.payload, e.eventType))).rawText; }
    catch (err) { text = ''; console.error(`  single-shot ${e.label} error:`, err instanceof Error ? err.message : err); }
    const parsed = parseAgentXml(text);
    const skipped = /<skip_summary[\s/>]/.test(text) && !/<observation[\s>]/.test(text);
    out.push({ label: e.label, text, skipped, parsed: parsed.valid });
  }
  return out;
}

const mean = (n: number[]) => n.length ? n.reduce((a, b) => a + b, 0) / n.length : NaN;
const fmt = (n: number) => Number.isNaN(n) ? ' n/a ' : n.toFixed(2);

async function main(): Promise<void> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  ModeManager.getInstance().loadMode('code');
  const mode = ModeManager.getInstance().getActiveMode();

  console.log(`\nGAP1 — single-shot (server) vs multi-turn (worker) on the SAME model (${OLLAMA_MODEL})`);
  console.log(`Blind judge: ${JUDGE_MODEL}. Corpus: ${EVENT_PAYLOADS.length} events\n`);

  console.log('Running multi-turn arm (worker conversation shape)…');
  const multi = await runMultiTurn(mode);
  console.log('Running single-shot arm (server provider)…');
  const single = await runSingleShot();

  // Judge every WRITTEN observation on both arms (skips judged separately, below).
  const rows: Array<{ arm: 'single' | 'multi'; label: string; skipped: boolean; parsed: boolean; scores?: Scores; scoreError?: string; text: string }> = [];
  for (const [arm, list] of [['single', single], ['multi', multi]] as const) {
    for (const pe of list) {
      const row: typeof rows[number] = { arm, label: pe.label, skipped: pe.skipped, parsed: pe.parsed, text: pe.text };
      if (!pe.skipped) {
        const src = EVENT_PAYLOADS.find(e => e.label === pe.label)?.payload;
        const scored = await judge(apiKey, src, pe.text);
        if ('error' in scored) row.scoreError = scored.error; else row.scores = scored;
      }
      rows.push(row);
    }
  }

  const per = (a: 'single' | 'multi') => rows.filter(r => r.arm === a && r.scores);
  const dimMean = (a: 'single' | 'multi', d: Dimension) => mean(per(a).map(r => r.scores![d]));
  const overall = (a: 'single' | 'multi') => mean(per(a).flatMap(r => DIMENSIONS.map(d => r.scores![d])));

  console.log(`\n── Observation quality (1-5, written observations only) ──`);
  console.log(`     ${per('single').length} single-shot, ${per('multi').length} multi-turn observations scored`);
  console.log(`  ${'Dimension'.padEnd(18)} ${'single'.padStart(7)} ${'multi'.padStart(7)} ${'gap(m-s)'.padStart(9)}`);
  for (const d of DIMENSIONS) {
    const s = dimMean('single', d), m = dimMean('multi', d);
    const gap = Number.isNaN(s) || Number.isNaN(m) ? NaN : m - s;
    console.log(`  ${d.padEnd(18)} ${fmt(s).padStart(7)} ${fmt(m).padStart(7)} ${((gap >= 0 ? '+' : '') + fmt(gap)).padStart(9)}`);
  }
  const so = overall('single'), mo = overall('multi');
  console.log(`  ${'─'.repeat(44)}`);
  console.log(`  ${'OVERALL'.padEnd(18)} ${fmt(so).padStart(7)} ${fmt(mo).padStart(7)} ${(((mo - so) >= 0 ? '+' : '') + fmt(mo - so)).padStart(9)}`);

  const skipsOf = (a: 'single' | 'multi') => rows.filter(r => r.arm === a && r.skipped).length;
  console.log(`\n── Coverage ──`);
  console.log(`  single-shot: wrote ${per('single').length}/${EVENT_PAYLOADS.length}, skipped ${skipsOf('single')}`);
  console.log(`  multi-turn : wrote ${per('multi').length}/${EVENT_PAYLOADS.length}, skipped ${skipsOf('multi')}`);

  const parseFail = (a: 'single' | 'multi') => rows.filter(r => r.arm === a && !r.parsed && !r.skipped).length;
  console.log(`\n  Parse failures: single ${parseFail('single')}, multi ${parseFail('multi')}`);
  console.log(`  Judge errors: ${rows.filter(r => r.scoreError).length}`);
  console.log(`\n  gap(m-s) > 0 means multi-turn scored higher. If the OVERALL gap is small`);
  console.log(`  (≈ within judge noise, ~0.2), single-shot is effectively at parity — GAP1 closed.`);
  console.log(`  CAVEAT: judged by ${JUDGE_MODEL}; small sample (directional, not statistical proof).\n`);

  const outPath = new URL('./last-run.json', import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`  Full detail → ${outPath}\n`);
}

main().catch(err => { console.error('turns eval failed:', err instanceof Error ? err.message : err); process.exit(1); });
