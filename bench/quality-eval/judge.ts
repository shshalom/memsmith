// SPDX-License-Identifier: Apache-2.0
//
// Blind rubric judge shared by the quality eval and the model bench. The judge
// never learns which model wrote an observation and never sees two paired.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const DIMENSIONS = ['faithfulness', 'specificity', 'typeCorrectness', 'usefulness', 'structure'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Scores = Record<Dimension, number> & { rationale: string };
export type SkipVerdict = { appropriate: boolean; rationale: string };

export interface Judge {
  provider: 'anthropic' | 'gemini' | 'ollama';
  model: string;
  apiKey: string;
}

const OLLAMA_URL = process.env.MEMSMITH_BENCH_OLLAMA ?? 'http://localhost:11434';

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

// A <skip_summary/> is a distinct outcome, not a bad observation. Scoring it on
// the 5-dim rubric (empty content → 1s) wrongly punishes a CORRECT skip, so skips
// are judged on a separate axis: was skipping appropriate for THIS event?
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

/** A skip is any output whose only content is a <skip_summary> marker. */
export function isSkip(rawText: string): boolean {
  return /<skip_summary[\s/>]/.test(rawText) && !/<observation[\s>]/.test(rawText);
}

async function callJudge<T>(judge: Judge, prompt: string, schema: object, maxTokens: number): Promise<T> {
  if (judge.provider === 'ollama') {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: judge.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0, num_ctx: 24576 },
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return JSON.parse(data.message?.content ?? '') as T;
  }
  if (judge.provider === 'gemini') {
    const res = await fetch(`${GEMINI_API_URL}/${encodeURIComponent(judge.model)}:generateContent?key=${encodeURIComponent(judge.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';
    return JSON.parse(text) as T;
  }
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': judge.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: judge.model,
      max_tokens: maxTokens,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return JSON.parse(data.content?.find(b => b.type === 'text')?.text ?? '') as T;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 2) return { error: err instanceof Error ? err.message : String(err) };
      await new Promise(r => setTimeout(r, 2_000 * (attempt + 1)));
    }
  }
}

/** Blind rubric score for one observation. `eventText` is the event as the generator saw it. */
export function scoreObservation(judge: Judge, eventText: string, observationText: string): Promise<Scores | { error: string }> {
  const prompt = [
    RUBRIC,
    '',
    '<source_event>',
    eventText,
    '</source_event>',
    '',
    '<observation>',
    observationText || '(empty — the model returned nothing)',
    '</observation>',
  ].join('\n');
  return withRetry(() => callJudge<Scores>(judge, prompt, JUDGE_SCHEMA, 2048));
}

export function judgeSkip(judge: Judge, eventText: string): Promise<SkipVerdict | { error: string }> {
  const prompt = [SKIP_RUBRIC, '', '<source_event>', eventText, '</source_event>'].join('\n');
  return withRetry(() => callJudge<SkipVerdict>(judge, prompt, SKIP_SCHEMA, 512));
}
