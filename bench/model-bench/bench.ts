// SPDX-License-Identifier: Apache-2.0
//
// Observation-generation model bench: many local and cloud models, one corpus,
// one blind judge. Answers "which model should MemSmith use, given RAM, speed,
// cost, and observation quality?"
//
// Every model gets the exact production prompt (buildServerGenerationPrompt).
// Local models run through Ollama's native /api/chat so the bench can pin
// num_ctx and disable thinking, and so it can read the resident memory from
// /api/ps after each model's run.
//
// Results are cached per model and per judge under results/, so a rerun only
// does missing work. Delete a model's file under results/gen to regenerate it;
// the judge re-scores any output whose text changed. Resampling the corpus
// requires deleting results/, because real-event labels are positional.
//
// Usage:
//   bun bench/model-bench/sample-events.ts           # once: real events -> .corpus.local.json
//   ANTHROPIC_API_KEY=... bun bench/model-bench/bench.ts
//
// Options (env):
//   MEMSMITH_BENCH_MODELS      comma list of provider:model (default DEFAULT_MODELS)
//   MEMSMITH_BENCH_JUDGE       comma list of provider:model, anthropic | gemini | ollama (default anthropic:claude-opus-5-5)
//   MEMSMITH_BENCH_NUM_CTX     Ollama context window (default 20480; the longest production prompt is ~16k tokens)
//   MEMSMITH_BENCH_PHASE       gen | footprint | judge | report | all (default all)
//   MEMSMITH_GEMINI_API_KEY    needed for gemini:* models or a gemini judge
//   MEMSMITH_OPENROUTER_API_KEY needed for openrouter:* models

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { buildServerGenerationPrompt } from '../../src/server/generation/providers/shared/prompt-builder.js';
import { EVENT_PAYLOADS, makeContext } from '../quality-eval/corpus.js';
import { DIMENSIONS, isSkip, judgeSkip, scoreObservation, type Judge, type Scores, type SkipVerdict } from '../quality-eval/judge.js';

const DEFAULT_MODELS = [
  'ollama:qwen2.5:14b',
  'ollama:llama3.1:8b',
  'ollama:qwen3.5:9b',
  'ollama:qwen3.5:4b',
  'ollama:qwen3.5:2b',
  'ollama:gemma4:12b',
  'ollama:gemma4:e4b',
  'ollama:gemma4:e2b',
  'ollama:qwen3:4b-instruct-2507-q4_K_M',
  'ollama:ministral-3:8b',
  'ollama:ministral-3:3b',
  'ollama:granite4:tiny-h',
  'ollama:granite4:micro',
  'ollama:lfm2.5:8b',
  'ollama:phi4-mini:3.8b',
  'ollama:llama3.2:3b',
  'ollama:gpt-oss:20b',
  'ollama:qwen3.5:9b-mlx',
  'anthropic:claude-haiku-5-5',
  'anthropic:claude-haiku-4-5-20251001',
  'anthropic:claude-sonnet-5-5',
];

const OLLAMA = process.env.MEMSMITH_BENCH_OLLAMA ?? 'http://localhost:11434';
const NUM_CTX = Number(process.env.MEMSMITH_BENCH_NUM_CTX ?? 20480);
const MAX_OUTPUT_TOKENS = 4096;
const TEMPERATURE = 0.3;
const RESULTS = new URL('./results/', import.meta.url).pathname;

interface BenchEvent { label: string; source: 'synthetic' | 'real'; eventType: string; payload: unknown }

interface Gen {
  label: string;
  rawText: string;
  error?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  note?: string;
}

interface GenFile {
  model: string;
  numCtx?: number;
  residentBytes?: number;
  residentVramBytes?: number;
  diskBytes?: number;
  gens: Gen[];
}

interface Verdict { label: string; outputHash?: string; scores?: Scores; skip?: SkipVerdict; error?: string }

function hash(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }
function slug(s: string): string { return s.replace(/[^a-zA-Z0-9.-]+/g, '_'); }
function readJson<T>(path: string): T | undefined { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined; }
function writeJson(path: string, v: unknown): void { writeFileSync(path, JSON.stringify(v, null, 2)); }

function loadCorpus(): BenchEvent[] {
  const synthetic = EVENT_PAYLOADS.map(e => ({ ...e, label: `syn-${e.label}`, source: 'synthetic' as const }));
  const realPath = new URL('./.corpus.local.json', import.meta.url).pathname;
  const real = (readJson<Array<Omit<BenchEvent, 'source'>>>(realPath) ?? []).map(e => ({ ...e, source: 'real' as const }));
  if (real.length === 0) console.warn('No real corpus found; run sample-events.ts first. Using synthetic events only.');
  return [...synthetic, ...real];
}

function promptFor(e: BenchEvent): string {
  return buildServerGenerationPrompt(makeContext(e.payload, e.eventType)).prompt;
}

/** The event exactly as the generator saw it, for the judge. */
function eventTextFor(prompt: string): string {
  const start = prompt.indexOf('<agent_event>');
  const end = prompt.lastIndexOf('</agent_event>');
  return start >= 0 && end > start ? prompt.slice(start, end + '</agent_event>'.length) : prompt;
}

async function generateOllama(model: string, prompt: string): Promise<Omit<Gen, 'label'>> {
  const body = (think: boolean | 'low' | undefined) => JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    ...(think === undefined ? {} : { think }),
    keep_alive: '10m',
    options: { temperature: TEMPERATURE, num_ctx: NUM_CTX, num_predict: MAX_OUTPUT_TOKENS },
  });
  const t0 = Date.now();
  // gpt-oss cannot turn reasoning off; 'low' is its minimum.
  let res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(model.startsWith('gpt-oss') ? 'low' : false) });
  let note: string | undefined;
  if (res.status === 400 && /think/i.test(await res.clone().text())) {
    res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(undefined) });
    note = 'no think control';
  }
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; load_duration?: number;
  };
  // Exclude a cold model load so latency reflects steady-state generation.
  const loadMs = Math.round((data.load_duration ?? 0) / 1e6);
  return {
    rawText: data.message?.content ?? '',
    latencyMs: Date.now() - t0 - (loadMs > 500 ? loadMs : 0),
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
    ...(note ? { note } : {}),
  };
}

async function generateAnthropic(model: string, prompt: string): Promise<Omit<Gen, 'label'>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is required');
  const t0 = Date.now();
  // No temperature, matching ClaudeObservationProvider: the 5.5 models reject it.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  return {
    rawText: data.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? '',
    latencyMs: Date.now() - t0,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}

async function generateGemini(model: string, prompt: string): Promise<Omit<Gen, 'label'>> {
  const key = process.env.MEMSMITH_GEMINI_API_KEY;
  if (!key) throw new Error('MEMSMITH_GEMINI_API_KEY is required');
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  return {
    rawText: data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '',
    latencyMs: Date.now() - t0,
    inputTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

async function generateOpenRouter(model: string, prompt: string): Promise<Omit<Gen, 'label'>> {
  const key = process.env.MEMSMITH_OPENROUTER_API_KEY;
  if (!key) throw new Error('MEMSMITH_OPENROUTER_API_KEY is required');
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: TEMPERATURE, max_tokens: MAX_OUTPUT_TOKENS }),
  });
  if (!res.ok) throw new Error(`openrouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return {
    rawText: data.choices?.[0]?.message?.content ?? '',
    latencyMs: Date.now() - t0,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

function generatorFor(spec: string): { provider: string; model: string; run: (p: string) => Promise<Omit<Gen, 'label'>> } {
  const i = spec.indexOf(':');
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  const run = { ollama: generateOllama, anthropic: generateAnthropic, gemini: generateGemini, openrouter: generateOpenRouter }[provider];
  if (!run) throw new Error(`unknown provider in ${spec}`);
  return { provider, model, run: p => run(model, p) };
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

async function ollamaFootprint(model: string): Promise<Pick<GenFile, 'residentBytes' | 'residentVramBytes' | 'diskBytes'>> {
  const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: Array<{ name: string; size: number; size_vram: number }> };
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as { models?: Array<{ name: string; size: number }> };
  const hit = ps.models?.find(m => m.name === model || m.name === `${model}:latest`);
  const disk = tags.models?.find(m => m.name === model || m.name === `${model}:latest`);
  return { residentBytes: hit?.size, residentVramBytes: hit?.size_vram, diskBytes: disk?.size };
}

async function unloadOllama(model: string): Promise<void> {
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
}

// MemSmith's own Ollama recovery runs `pkill -x ollama` when its readiness probe
// is slow, which happens while the bench holds the GPU. Wait for the restarted
// daemon instead of recording the event as a model failure.
async function withReconnect<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 5 || !/Unable to connect|socket connection was closed|ECONNREFUSED/i.test(msg)) throw err;
      await new Promise(r => setTimeout(r, 15_000));
    }
  }
}

// Resident memory read in isolation: unload everything, load one model with a
// one-token request at the bench num_ctx, then read /api/ps. Readings taken at
// the end of a generation run are unreliable when another client (MemSmith's
// own generation) reloads models in between.
async function measureFootprints(models: string[]): Promise<void> {
  for (const spec of models.filter(m => m.startsWith('ollama:'))) {
    const model = spec.slice('ollama:'.length);
    const path = `${RESULTS}gen/${slug(spec)}.json`;
    const file = readJson<GenFile>(path);
    if (!file) continue;
    const loaded = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models?: Array<{ name: string }> };
    for (const m of loaded.models ?? []) if (m.name !== model) await unloadOllama(m.name);
    await withReconnect(() => fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, keep_alive: '1m', options: { num_ctx: NUM_CTX, num_predict: 1 } }),
    }).then(r => r.text()));
    Object.assign(file, { numCtx: NUM_CTX }, await ollamaFootprint(model));
    writeJson(path, file);
    console.log(`  ${spec}: ${gb(file.residentBytes)} GB resident at num_ctx ${NUM_CTX}`);
    await unloadOllama(model);
  }
}

async function runGeneration(models: string[], corpus: BenchEvent[]): Promise<void> {
  mkdirSync(`${RESULTS}gen`, { recursive: true });
  for (const spec of models) {
    const path = `${RESULTS}gen/${slug(spec)}.json`;
    const file = readJson<GenFile>(path) ?? { model: spec, gens: [] };
    const done = new Set(file.gens.filter(g => !g.error).map(g => g.label));
    const todo = corpus.filter(e => !done.has(e.label));
    if (todo.length === 0) { console.log(`  ${spec}: cached`); continue; }

    const gen = generatorFor(spec);
    file.gens = file.gens.filter(g => !g.error);
    console.log(`  ${spec}: generating ${todo.length} events`);
    // Local models run one request at a time so latency is single-stream, as a
    // solo user's machine sees it. Cloud models run 4-wide.
    await pool(todo, gen.provider === 'ollama' ? 1 : 4, async e => {
      try {
        file.gens.push({ label: e.label, ...(await withReconnect(() => gen.run(promptFor(e)))) });
      } catch (err) {
        file.gens.push({ label: e.label, rawText: '', latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
      }
      writeJson(path, file);
    });
    if (gen.provider === 'ollama') {
      Object.assign(file, { numCtx: NUM_CTX }, await withReconnect(() => ollamaFootprint(gen.model)).catch(() => ({})));
      writeJson(path, file);
      await unloadOllama(gen.model);
    }
  }
}

function parseJudge(spec: string): Judge {
  const i = spec.indexOf(':');
  const provider = spec.slice(0, i) as Judge['provider'];
  const apiKey = provider === 'ollama' ? 'none' : provider === 'gemini' ? process.env.MEMSMITH_GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`no API key for judge ${spec}`);
  return { provider, model: spec.slice(i + 1), apiKey };
}

async function runJudging(models: string[], corpus: BenchEvent[], judgeSpec: string): Promise<void> {
  const judge = parseJudge(judgeSpec);
  const dir = `${RESULTS}judge/${slug(judgeSpec)}`;
  mkdirSync(dir, { recursive: true });
  const eventText = new Map(corpus.map(e => [e.label, eventTextFor(promptFor(e))]));
  for (const spec of models) {
    const gens = readJson<GenFile>(`${RESULTS}gen/${slug(spec)}.json`)?.gens ?? [];
    const path = `${dir}/${slug(spec)}.json`;
    const current = new Map(gens.map(g => [g.label, hash(g.rawText)]));
    const verdicts = (readJson<Verdict[]>(path) ?? []).filter(v => !v.error && v.outputHash === current.get(v.label));
    const done = new Set(verdicts.map(v => v.label));
    const todo = gens.filter(g => !g.error && !done.has(g.label) && eventText.has(g.label));
    if (todo.length === 0) continue;
    console.log(`  judging ${spec}: ${todo.length}`);
    await pool(todo, judge.provider === 'ollama' ? 1 : 6, async g => {
      const text = eventText.get(g.label)!;
      if (isSkip(g.rawText)) {
        const v = await judgeSkip(judge, text);
        verdicts.push('error' in v ? { label: g.label, error: v.error } : { label: g.label, outputHash: hash(g.rawText), skip: v });
      } else {
        const s = await scoreObservation(judge, text, g.rawText);
        verdicts.push('error' in s ? { label: g.label, error: s.error } : { label: g.label, outputHash: hash(g.rawText), scores: s });
      }
      writeJson(path, verdicts);
    });
  }
}

// USD per million tokens (input, output), for prompts under any long-context tier.
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-haiku-4-5-20251001': [1.00, 5.00],
  'gemini-2.5-flash-lite': [0.10, 0.40],
};

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
function f(n: number | undefined, d = 2): string { return n === undefined || Number.isNaN(n) ? 'n/a' : n.toFixed(d); }
function gb(b: number | undefined): string { return b ? (b / 1e9).toFixed(1) : 'n/a'; }

function report(models: string[], corpus: BenchEvent[], judgeSpecs: string[]): string {
  const source = new Map(corpus.map(e => [e.label, e.source]));
  const lines: string[] = [];
  lines.push(`Corpus: ${corpus.filter(e => e.source === 'synthetic').length} synthetic + ${corpus.filter(e => e.source === 'real').length} real events. Local num_ctx ${NUM_CTX}.`, '');
  for (const judgeSpec of judgeSpecs) {
    lines.push(`### Judge: ${judgeSpec}`, '');
    lines.push('| Model | Usable | Quality (1-5) | Real-event quality | Faithful | Written | Skips | Bad skips | Parse fail | Errors | p50 latency (s) | p95 latency (s) | RAM (GB) | Disk (GB) | USD per 1k events |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const rows: Array<{ q: number; line: string }> = [];
    for (const spec of models) {
      const file = readJson<GenFile>(`${RESULTS}gen/${slug(spec)}.json`);
      if (!file) continue;
      const verdicts = readJson<Verdict[]>(`${RESULTS}judge/${slug(judgeSpec)}/${slug(spec)}.json`) ?? [];
      const scored = verdicts.filter(v => v.scores);
      const overall = (vs: Verdict[]) => mean(vs.flatMap(v => DIMENSIONS.map(d => v.scores![d])));
      const q = overall(scored);
      const qReal = overall(scored.filter(v => source.get(v.label) === 'real'));
      const skips = verdicts.filter(v => v.skip);
      const ok = file.gens.filter(g => !g.error);
      const unparsed = ok.filter(g => !isSkip(g.rawText) && !parseAgentXml(g.rawText).valid).length;
      const lat = ok.map(g => g.latencyMs / 1000);
      const model = spec.slice(spec.indexOf(':') + 1);
      const price = PRICES[model];
      const cost = price
        ? (mean(ok.map(g => g.inputTokens ?? 0)) * price[0] + mean(ok.map(g => g.outputTokens ?? 0)) * price[1]) / 1000
        : undefined;
      // Usable: the event produced either a correct skip or an observation the
      // judge rates 3.5+ on average. A wrong skip is a memory MemSmith never keeps.
      const usable = verdicts.filter(v =>
        (v.skip && v.skip.appropriate) || (v.scores && mean(DIMENSIONS.map(d => v.scores![d])) >= 3.5)).length;
      const judgeErrors = verdicts.filter(v => v.error).length;
      const judged = verdicts.length - judgeErrors;
      const usableRate = judged ? usable / (judged + file.gens.length - ok.length) : NaN;
      rows.push({
        q: usableRate,
        line: `| ${spec}${judgeErrors ? ` (${judgeErrors} unjudged)` : ''} | **${f(usableRate * 100, 0)}%** | ${f(q)} | ${f(qReal)} | ${f(mean(scored.map(v => v.scores!.faithfulness)))} | ${scored.length} | ${skips.length} | ${skips.filter(v => !v.skip!.appropriate).length} | ${unparsed} | ${file.gens.length - ok.length} | ${f(pct(lat, 0.5), 1)} | ${f(pct(lat, 0.95), 1)} | ${gb(file.residentBytes)} | ${gb(file.diskBytes)} | ${cost === undefined ? (spec.startsWith('ollama:') ? '0' : 'n/a') : '$' + f(cost, 3)} |`,
      });
    }
    rows.sort((a, b) => (Number.isNaN(b.q) ? -1 : b.q) - (Number.isNaN(a.q) ? -1 : a.q)).forEach(r => lines.push(r.line));
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  ModeManager.getInstance().loadMode('code');
  const models = (process.env.MEMSMITH_BENCH_MODELS?.split(',').map(s => s.trim()).filter(Boolean)) ?? DEFAULT_MODELS;
  const judges = (process.env.MEMSMITH_BENCH_JUDGE ?? 'anthropic:claude-opus-5-5').split(',').map(s => s.trim());
  const phase = process.env.MEMSMITH_BENCH_PHASE ?? 'all';
  const corpus = loadCorpus();
  console.log(`Model bench: ${models.length} models x ${corpus.length} events; judges ${judges.join(', ')}\n`);

  if (phase === 'gen' || phase === 'all') await runGeneration(models, corpus);
  if (phase === 'footprint') await measureFootprints(models);
  if (phase === 'judge' || phase === 'all') for (const j of judges) await runJudging(models, corpus, j);
  const md = report(models, corpus, judges);
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(`${RESULTS}REPORT.md`, md);
  console.log(`\n${md}`);
}

main().catch(err => {
  console.error('model bench failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
