# Ollama Provider + Shared Format Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyless local-Ollama observation-generation provider (default `llama3.1:8b`) and a bounded, best-effort reformat guard that re-prompts any provider on malformed output before falling through to today's unchanged parse_error→fail path.

**Architecture:** `OllamaObservationProvider` mirrors `OpenRouterObservationProvider` (both POST an OpenAI-compatible `/v1/chat/completions`), keyless with default base URL `http://localhost:11434/v1`. The reformat guard lives in `ProviderObservationGenerator.generateAndPersist` — the one place that already calls `generate()` and owns the parse decision. `generate()` gains an optional `opts.reformatReason` that flows through the shared `buildServerGenerationPrompt` as a strict addendum, so all four providers inherit the guard.

**Tech Stack:** TypeScript, bun test, server-beta generation path (`src/server/generation/`), Postgres integration tests gated on `CLAUDE_MEM_TEST_POSTGRES_URL`.

## Global Constraints

- Reference spec: `docs/superpowers/specs/2026-07-05-ollama-provider-format-guard-design.md`.
- Scope is the **server-beta** path only (`src/server/generation/`). Do NOT touch worker-mode/CLI/installer `ProviderId` unions (`npx-cli`, `worker-types`, `SettingsRoutes`, telemetry scrub).
- Default Ollama model: `llama3.1:8b`. Default base URL: `http://localhost:11434/v1`. Ollama is **keyless** — an unset API key must NOT disable it (unlike the keyed providers).
- Reformat guard default: `CLAUDE_MEM_REFORMAT_RETRIES=1`, clamped to `[0,3]`; `0` fully disables (exact pre-guard behavior). Guard applies **uniformly** to all providers.
- Terminal outcome must be **byte-identical to today** when output is still malformed after retries: `parse_error` → `markGenerationFailed(retryable:false)`, no BullMQ job-attempt change.
- `<skip_summary />` and empty `rawText` parse as VALID — the guard must never retry them.
- Provider *errors* (thrown `ServerClassifiedProviderError`) are NOT format failures — never swallow a throw into a reformat retry; let it propagate.
- Bun test: `import { describe, it, expect } from 'bun:test'`. Run with `~/.bun/bin/bun test <path>`. Postgres tests need `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"`.
- Run `npm run build` after source changes to `src/server/` and commit the regenerated `plugin/scripts/server-service.cjs` bundle (git-tracked artifact; stale bundle = fix doesn't ship).

---

### Task 1: Reformat-aware prompt builder + interface widening

**Files:**
- Modify: `src/server/generation/providers/shared/prompt-builder.ts` (add `reformatReason` option + strict addendum)
- Modify: `src/server/generation/providers/shared/types.ts` (widen `providerLabel` union; add optional `opts` to `generate`)
- Test: `tests/server/generation/providers.test.ts` (prompt-builder addendum cases)

**Interfaces:**
- Consumes: `buildServerGenerationPrompt(context, options)` currently `options: { mode?: ModeConfig }`; `BuildServerPromptResult = { prompt, hadPrivateContent, skippedAll }`.
- Produces:
  - `buildServerGenerationPrompt(context, options?: { mode?: ModeConfig; reformatReason?: string })` — when `reformatReason` is a non-empty string, the returned `prompt` ends with a strict addendum block.
  - `ServerGenerationProvider.generate(context, signal?, opts?: { reformatReason?: string })`.
  - `providerLabel: 'claude' | 'gemini' | 'openrouter' | 'ollama'`.

- [ ] **Step 1: Write the failing test** (append to `tests/server/generation/providers.test.ts`)

```ts
describe('buildServerGenerationPrompt reformat addendum', () => {
  it('appends a strict format addendum when reformatReason is set', () => {
    const { prompt } = buildServerGenerationPrompt(makeContext(), {
      reformatReason: 'no <observation> block found',
    });
    expect(prompt).toContain('could not be parsed');
    expect(prompt).toContain('no <observation> block found');
    expect(prompt).toContain('ONLY');
    expect(prompt).toContain('no markdown code fences');
    expect(prompt).toContain('<skip_summary />');
  });

  it('produces no addendum when reformatReason is absent', () => {
    const base = buildServerGenerationPrompt(makeContext()).prompt;
    const withEmpty = buildServerGenerationPrompt(makeContext(), { reformatReason: '' }).prompt;
    expect(withEmpty).toBe(base);
    expect(base).not.toContain('could not be parsed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/generation/providers.test.ts -t "reformat addendum"`
Expected: FAIL (addendum text not present).

- [ ] **Step 3: Implement — widen types** in `src/server/generation/providers/shared/types.ts`

Change the interface (line ~30-33):
```ts
export interface ServerGenerationProvider {
  readonly providerLabel: 'claude' | 'gemini' | 'openrouter' | 'ollama';
  generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
    opts?: { reformatReason?: string },
  ): Promise<ServerGenerationResult>;
}
```

- [ ] **Step 4: Implement — prompt addendum** in `src/server/generation/providers/shared/prompt-builder.ts`

Change the signature (line ~43-46):
```ts
export function buildServerGenerationPrompt(
  context: ServerGenerationContext,
  options: { mode?: ModeConfig; reformatReason?: string } = {},
): BuildServerPromptResult {
```

Then, where the `prompt` const is built (the array joined at line ~75-96), append the addendum after the schema. Replace the `const prompt = [ ... ].join('\n');` with:
```ts
  const reformatReason = options.reformatReason?.trim();
  const reformatAddendum = reformatReason
    ? [
        '',
        `IMPORTANT: your previous response could not be parsed (${reformatReason}).`,
        'Output ONLY the XML observation block(s) described above — no prose',
        'before or after, no markdown code fences, no explanation. If nothing is',
        'worth recording, output exactly <skip_summary /> and nothing else.',
      ]
    : [];

  const prompt = [
    '<server_beta_observation_request>',
    `  <project_id>${escapeXml(context.project.projectId)}</project_id>`,
    `  <team_id>${escapeXml(context.project.teamId)}</team_id>` + sessionTag + projectTag,
    `  <generation_job_id>${escapeXml(context.job.id)}</generation_job_id>`,
    '  <agent_events>',
    eventBlocks.length > 0 ? eventBlocks.join('\n') : '    <!-- empty after privacy stripping -->',
    '  </agent_events>',
    '</server_beta_observation_request>',
    '',
    'You are observing an agent at work. Return one or more',
    '<observation>...</observation> XML blocks summarizing durable, useful',
    'discoveries from the events above. If the events contain nothing worth',
    'recording (e.g., everything was scrubbed by privacy filters or the',
    'activity was trivial), return a single self-closing <skip_summary />',
    'tag and nothing else. Do not include any prose outside the XML.',
    '',
    'For "decision" observations, fill <why> (one-sentence rationale) and <rejected_alternatives>. For work items (task/blocker/deferred), set <lifecycle>.',
    '',
    'Schema for each <observation> block:',
    observationOutputSchema,
    ...reformatAddendum,
  ].join('\n');
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/server/generation/providers.test.ts`
Expected: PASS (all existing OpenRouter/Claude/Gemini tests + the 2 new addendum tests). The union widening is source-compatible (adds a member).

- [ ] **Step 6: Commit**

```bash
git add src/server/generation/providers/shared/types.ts src/server/generation/providers/shared/prompt-builder.ts tests/server/generation/providers.test.ts
git commit -m "feat(server): reformat-aware prompt builder + widen providerLabel for ollama"
```

---

### Task 2: OllamaObservationProvider

**Files:**
- Create: `src/server/generation/providers/OllamaObservationProvider.ts`
- Test: `tests/server/generation/providers.test.ts` (Ollama suite)

**Interfaces:**
- Consumes: `resolveOpenRouterChatCompletionsUrl(baseUrl?)` from `src/shared/openrouter-base-url.js`; `classifyHttpProviderError`, `ServerClassifiedProviderError` from `./shared/error-classification.js`; `buildServerGenerationPrompt` from `./shared/prompt-builder.js`; `ServerGenerationContext/Provider/Result` from `./shared/types.js`. `generate` signature from Task 1 (`opts?: { reformatReason?: string }`).
- Produces: `class OllamaObservationProvider implements ServerGenerationProvider` with `providerLabel = 'ollama'`; constructor `OllamaObservationProviderOptions = { apiKey?: string; model?: string; baseUrl?: string; maxOutputTokens?: number; fetchImpl?: typeof fetch }`; `DEFAULT_MODEL = 'llama3.1:8b'`, `DEFAULT_BASE_URL = 'http://localhost:11434/v1'`.

- [ ] **Step 1: Write the failing test** (append an Ollama `describe` to `tests/server/generation/providers.test.ts`; add the import at top: `import { OllamaObservationProvider } from '../../../src/server/generation/providers/OllamaObservationProvider.js';`)

```ts
describe('OllamaObservationProvider', () => {
  it('parses OpenAI-style response, defaults model llama3.1:8b and localhost URL', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, {
        choices: [{ message: { content: '<observation><type>x</type><title>o</title></observation>' } }],
        usage: { total_tokens: 42 },
      }),
    );
    const provider = new OllamaObservationProvider({ fetchImpl: capturing.fetch });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(42);
    expect(result.providerLabel).toBe('ollama');
    expect(capturing.lastUrl).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse(String(capturing.lastInit?.body)) as { model?: string };
    expect(body.model).toBe('llama3.1:8b');
  });

  it('constructs without an API key and sends no Authorization header', async () => {
    const capturing = new CapturingFetch(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
    const provider = new OllamaObservationProvider({ fetchImpl: capturing.fetch });
    await provider.generate(makeContext());
    const headers = (capturing.lastInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends Authorization when an apiKey is supplied (auth-proxied Ollama)', async () => {
    const capturing = new CapturingFetch(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
    const provider = new OllamaObservationProvider({ apiKey: 'k', fetchImpl: capturing.fetch });
    await provider.generate(makeContext());
    const headers = (capturing.lastInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer k');
  });

  it('honors CLAUDE_MEM_OLLAMA_URL-style baseUrl and CLAUDE_MEM_SERVER_MODEL-style model overrides', async () => {
    const capturing = new CapturingFetch(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));
    const provider = new OllamaObservationProvider({
      baseUrl: 'http://ollama.internal:11434/v1',
      model: 'qwen2.5:14b',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('http://ollama.internal:11434/v1/chat/completions');
    const body = JSON.parse(String(capturing.lastInit?.body)) as { model?: string };
    expect(body.model).toBe('qwen2.5:14b');
  });

  it('classifies a connection failure (fetch throws) as transient', async () => {
    const throwingFetch: typeof fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
    const provider = new OllamaObservationProvider({ fetchImpl: throwingFetch });
    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      expect((error as ServerClassifiedProviderError).kind).toBe('transient');
    }
  });

  it('returns the private-skip sentinel without calling fetch when all events are private', async () => {
    const capturing = new CapturingFetch(jsonResponse(200, { choices: [{ message: { content: 'unused' } }] }));
    const provider = new OllamaObservationProvider({ fetchImpl: capturing.fetch });
    // makeContext with a single fully-private event so skippedAll is true.
    const result = await provider.generate(makeContext({ privateOnly: true }));
    expect(result.rawText).toContain('skip_summary');
    expect(capturing.lastUrl).toBeUndefined();
  });
});
```

Note: if `makeContext` does not already support a `privateOnly` option, drop the last test (the skip path is identical to OpenRouter's and covered there); do NOT modify `makeContext` signature just for this — check its definition first and only include the last test if `makeContext({ privateOnly: true })` produces `skippedAll`.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/generation/providers.test.ts -t "OllamaObservationProvider"`
Expected: FAIL (module `OllamaObservationProvider` not found).

- [ ] **Step 3: Implement** `src/server/generation/providers/OllamaObservationProvider.ts`

```ts
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenRouterChatCompletionsUrl } from '../../../shared/openrouter-base-url.js';
import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export interface OllamaObservationProviderOptions {
  /** Optional. Ollama is keyless by default; supply only when fronted by an auth proxy. */
  apiKey?: string;
  model?: string;
  /** OpenAI-compatible base URL. Defaults to http://localhost:11434/v1. */
  baseUrl?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface OllamaResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string };
}

export class OllamaObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'ollama' as const;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaObservationProviderOptions = {}) {
    // Keyless by default — no auth_invalid throw when apiKey is absent.
    this.apiKey = options.apiKey && options.apiKey.length > 0 ? options.apiKey : undefined;
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiUrl = resolveOpenRouterChatCompletionsUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
    opts?: { reformatReason?: string },
  ): Promise<ServerGenerationResult> {
    const built = buildServerGenerationPrompt(
      context,
      opts?.reformatReason ? { reformatReason: opts.reformatReason } : {},
    );
    if (built.skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    let response: Response;
    try {
      response = await this.postChatCompletion(built.prompt, signal);
    } catch (networkError) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyHttpProviderError({ cause: err, providerLabel: 'ollama' });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`ollama API error: ${response.status} - ${bodyText}`),
        providerLabel: 'ollama',
      });
    }

    let data: OllamaResponse;
    try {
      data = (await response.json()) as OllamaResponse;
    } catch (parseError) {
      const err = parseError instanceof Error ? parseError : new Error(String(parseError));
      throw new ServerClassifiedProviderError('ollama returned invalid JSON', {
        kind: 'parse_error',
        cause: err,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`ollama API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: 'ollama',
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'ollama returned empty content', { provider: 'ollama', model: this.model });
    }
    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }

  private postChatCompletion(prompt: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: this.maxOutputTokens,
      }),
      signal,
    });
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (readError) {
    const err = readError instanceof Error ? readError : new Error(String(readError));
    logger.warn('SDK', 'Failed to read ollama error response body', { provider: 'ollama' }, err);
    return '';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/server/generation/providers.test.ts`
Expected: PASS (Ollama suite + all existing).

- [ ] **Step 5: Commit**

```bash
git add src/server/generation/providers/OllamaObservationProvider.ts tests/server/generation/providers.test.ts
git commit -m "feat(server): OllamaObservationProvider (keyless, default llama3.1:8b)"
```

---

### Task 3: Register `ollama` in the provider switch

**Files:**
- Modify: `src/server/runtime/create-server-service.ts` (add `ollama` branch to `instantiateServerGenerationProvider`)
- Test: `tests/server/generation/providers.test.ts` OR a new focused unit — see below.

**Interfaces:**
- Consumes: `OllamaObservationProvider` (Task 2); env `CLAUDE_MEM_SERVER_PROVIDER`, `CLAUDE_MEM_SERVER_MODEL`, `CLAUDE_MEM_OLLAMA_URL`, `CLAUDE_MEM_OLLAMA_API_KEY`.
- Produces: `instantiateServerGenerationProvider('ollama')` returns an `OllamaObservationProvider` even with no API key set.

Note: `instantiateServerGenerationProvider` may not be exported. First check: `grep -n "export function instantiateServerGenerationProvider\|export function buildServerGenerationProviderFromEnv" src/server/runtime/create-server-service.ts`. If neither is exported, export `instantiateServerGenerationProvider` (add `export`) so the test can call it directly; this is a safe, minimal widening of the module surface.

- [ ] **Step 1: Write the failing test** — create `tests/server/generation/provider-registration.test.ts`

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import { OllamaObservationProvider } from '../../../src/server/generation/providers/OllamaObservationProvider.js';

describe('instantiateServerGenerationProvider — ollama', () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env.CLAUDE_MEM_SERVER_MODEL = prev.CLAUDE_MEM_SERVER_MODEL;
    process.env.CLAUDE_MEM_OLLAMA_URL = prev.CLAUDE_MEM_OLLAMA_URL;
    process.env.CLAUDE_MEM_OLLAMA_API_KEY = prev.CLAUDE_MEM_OLLAMA_API_KEY;
  });

  it('instantiates Ollama without any API key (keyless)', () => {
    delete process.env.CLAUDE_MEM_OLLAMA_API_KEY;
    delete process.env.CLAUDE_MEM_SERVER_MODEL;
    const provider = instantiateServerGenerationProvider('ollama');
    expect(provider).toBeInstanceOf(OllamaObservationProvider);
    expect(provider?.providerLabel).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/generation/provider-registration.test.ts`
Expected: FAIL (either `instantiateServerGenerationProvider` not exported, or returns null for `'ollama'`).

- [ ] **Step 3: Implement** — in `src/server/runtime/create-server-service.ts`, add an import at the top alongside the other provider imports:
```ts
import { OllamaObservationProvider } from '../generation/providers/OllamaObservationProvider.js';
```
Add the branch inside `instantiateServerGenerationProvider`, BEFORE the final `return null;` (place it after the `openrouter` branch):
```ts
  if (provider === 'ollama') {
    // Keyless by default — do NOT gate on an API key. A key is only used when
    // Ollama is fronted by an auth proxy.
    const apiKey = process.env.CLAUDE_MEM_OLLAMA_API_KEY ?? '';
    const opts: { apiKey?: string; model?: string; baseUrl?: string } = {
      model: process.env.CLAUDE_MEM_SERVER_MODEL ?? 'llama3.1:8b',
    };
    if (apiKey) opts.apiKey = apiKey;
    const baseUrl = process.env.CLAUDE_MEM_OLLAMA_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OllamaObservationProvider(opts);
  }
```
If `instantiateServerGenerationProvider` was not exported, add `export` to its declaration.

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/server/generation/provider-registration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime/create-server-service.ts tests/server/generation/provider-registration.test.ts
git commit -m "feat(server): register ollama provider (keyless, model/url env overrides)"
```

---

### Task 4: The reformat guard in generateAndPersist

**Files:**
- Modify: `src/server/generation/ProviderObservationGenerator.ts` (`generateAndPersist` — wrap the single `generate()` call in a bounded reformat loop; add a `describeParseFailure` helper + `reformatRetryLimit` reader)
- Test: `tests/server/generation/provider-observation-generator.test.ts` (guard behavior via stub providers)

**Interfaces:**
- Consumes: `provider.generate(context, signal?, opts?)` (Task 1); `parseAgentXml` from `src/sdk/parser.js`; env `CLAUDE_MEM_REFORMAT_RETRIES`.
- Produces: no new exported API; `generateAndPersist` now calls `generate()` 1..(1+N) times where N = clamped `CLAUDE_MEM_REFORMAT_RETRIES` (default 1), stopping as soon as `parseAgentXml(rawText).valid`.

- [ ] **Step 1: Write the failing test** — add to `tests/server/generation/provider-observation-generator.test.ts`. Extend the existing `StubProvider` OR add a `SequenceStubProvider` that returns different text per call. Add this provider class near the top and these tests inside the `describe` (they need Postgres — they sit alongside the file's existing DB-gated tests):

```ts
class SequenceStubProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  calls = 0;
  lastReformatReason: string | undefined;
  constructor(private readonly responses: string[]) {}
  async generate(_ctx: unknown, _signal?: AbortSignal, opts?: { reformatReason?: string }) {
    this.lastReformatReason = opts?.reformatReason;
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    return { rawText: this.responses[idx]!, providerLabel: this.providerLabel };
  }
}

const VALID_XML = '<observation><type>discovery</type><title>ok</title><facts><fact>f</fact></facts></observation>';
const GARBAGE = 'sure! here is your observation: it was a discovery about ok.';
```

Tests:
```ts
it('reformat guard: malformed then valid → persists, provider called twice', async () => {
  const prev = process.env.CLAUDE_MEM_REFORMAT_RETRIES;
  process.env.CLAUDE_MEM_REFORMAT_RETRIES = '1';
  try {
    const provider = new SequenceStubProvider([GARBAGE, VALID_XML]);
    const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
    const result = await generator.process(makeJob());
    expect(provider.calls).toBe(2);
    expect(provider.lastReformatReason).toBeTruthy();
    expect(result.observationCount).toBe(1);
    const reloaded = await storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
    expect(reloaded?.status).toBe('completed');
  } finally {
    process.env.CLAUDE_MEM_REFORMAT_RETRIES = prev;
  }
});

it('reformat guard: still malformed after retries → parse_error, job failed (unchanged terminal outcome)', async () => {
  const prev = process.env.CLAUDE_MEM_REFORMAT_RETRIES;
  process.env.CLAUDE_MEM_REFORMAT_RETRIES = '1';
  try {
    const provider = new SequenceStubProvider([GARBAGE, GARBAGE]);
    const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);
    expect(provider.calls).toBe(2); // 1 initial + 1 reformat
    const reloaded = await storage.observationGenerationJobs.getByIdForScope({ id: jobId, projectId, teamId });
    expect(reloaded?.status).toBe('failed');
  } finally {
    process.env.CLAUDE_MEM_REFORMAT_RETRIES = prev;
  }
});

it('reformat guard disabled (retries=0): provider called once, fails on malformed', async () => {
  const prev = process.env.CLAUDE_MEM_REFORMAT_RETRIES;
  process.env.CLAUDE_MEM_REFORMAT_RETRIES = '0';
  try {
    const provider = new SequenceStubProvider([GARBAGE]);
    const generator = new ProviderObservationGenerator({ pool: pool as unknown as pg.Pool, provider } as never);
    await expect(generator.process(makeJob())).rejects.toThrow(/parse error/);
    expect(provider.calls).toBe(1);
  } finally {
    process.env.CLAUDE_MEM_REFORMAT_RETRIES = prev;
  }
});

it('reformat guard: a thrown provider error on the retry propagates (not swallowed as format failure)', async () => {
  const prev = process.env.CLAUDE_MEM_REFORMAT_RETRIES;
  process.env.CLAUDE_MEM_REFORMAT_RETRIES = '1';
  try {
    const provider: ServerGenerationProvider = {
      providerLabel: 'claude',
      calls: 0,
      async generate(_c: unknown, _s?: AbortSignal, _o?: { reformatReason?: string }) {
        // first call malformed, second call throws
        (this as { calls: number }).calls += 1;
        if ((this as { calls: number }).calls === 1) return { rawText: GARBAGE, providerLabel: 'claude' as const };
        throw new Error('boom on reformat');
      },
    } as never;
    await expect(generator_process_with(provider)).rejects.toThrow(/boom on reformat/);
  } finally {
    process.env.CLAUDE_MEM_REFORMAT_RETRIES = prev;
  }
});
```
(For the last test, if a `generator_process_with` helper does not exist, inline the generator construction as in the other tests; the point is: reformat call throws → that error propagates, not a `/parse error/`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/generation/provider-observation-generator.test.ts`
Expected: FAIL — provider currently called once; malformed-then-valid does not persist; `provider.calls` is 1 not 2.

- [ ] **Step 3: Implement** — in `src/server/generation/ProviderObservationGenerator.ts`:

Add the import near the top (with the other `src/sdk` / generation imports):
```ts
import { parseAgentXml } from '../../sdk/parser.js';
```

Add two module-scope helpers (near the bottom of the file, beside the other private helpers/free functions):
```ts
function reformatRetryLimit(): number {
  const raw = Number(process.env.CLAUDE_MEM_REFORMAT_RETRIES ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, Math.min(3, Math.trunc(raw)));
}

// A short, safe machine reason for why the model output could not be parsed,
// used to steer the reformat re-prompt. No user data beyond structure.
function describeParseFailure(rawText: string): string {
  const t = rawText.trim();
  if (t.length === 0) return 'empty response';
  if (!/<observation[\s>]/.test(t) && !/<summary[\s>]/.test(t) && !/<skip_summary/.test(t)) {
    return 'no <observation> block found';
  }
  return 'the XML observation block was malformed or empty';
}
```

Replace the single `generate()` call in `generateAndPersist` (the `const result = await this.options.provider.generate({ ... });` block, ~line 223-232) with the guarded loop:
```ts
    const genContext = {
      job: fresh,
      events,
      project: {
        projectId: fresh.projectId,
        teamId: fresh.teamId,
        serverSessionId: fresh.serverSessionId,
        projectName: project?.name ?? null,
      },
    };

    let result = await this.options.provider.generate(genContext);
    // Best-effort format guard: if the model's output can't be parsed, re-prompt
    // it strictly up to reformatRetryLimit() times. parseAgentXml here is only
    // used to DECIDE whether to retry; the final result still flows through the
    // unchanged processGeneratedResponse below, so persistence, idempotency, and
    // the parse_error terminal path are identical to pre-guard behavior. Note
    // <skip_summary/> and empty text parse as valid → never retried. A thrown
    // provider error inside a retry propagates (it is not a format failure).
    const maxReformat = reformatRetryLimit();
    for (let attempt = 0; attempt < maxReformat; attempt++) {
      if (parseAgentXml(result.rawText).valid) break;
      const reformatReason = describeParseFailure(result.rawText);
      result = await this.options.provider.generate(genContext, undefined, { reformatReason });
    }
```
Everything after (the `persistInput` block onward) is unchanged and continues to use `result.rawText`, `result.modelId`, etc.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/generation/provider-observation-generator.test.ts`
Expected: PASS (guard tests + existing generator tests, incl. the malformed-XML terminal-fail test).

- [ ] **Step 5: Commit**

```bash
git add src/server/generation/ProviderObservationGenerator.ts tests/server/generation/provider-observation-generator.test.ts
git commit -m "feat(server): bounded reformat guard on malformed generation output"
```

---

### Task 5: Docs + build the bundle

**Files:**
- Modify: `docs/deploy/aws.md` (env-var table: add `CLAUDE_MEM_SERVER_PROVIDER=ollama`, `CLAUDE_MEM_OLLAMA_URL`, `CLAUDE_MEM_OLLAMA_API_KEY`, `CLAUDE_MEM_REFORMAT_RETRIES`)
- Modify: `plugin/scripts/server-service.cjs` (regenerated by build)

**Interfaces:** none (docs + build artifact).

- [ ] **Step 1: Add env-var rows** to the table in `docs/deploy/aws.md` (the table that already lists `CLAUDE_MEM_SERVER_PROVIDER`, `CLAUDE_MEM_FTS_WEIGHT`, etc.):

```markdown
| `CLAUDE_MEM_SERVER_PROVIDER` | — | `claude`, `gemini`, `openrouter`, or `ollama` (local, keyless) |
| `CLAUDE_MEM_OLLAMA_URL` | `http://localhost:11434/v1` | Ollama OpenAI-compatible base URL (provider=ollama) |
| `CLAUDE_MEM_OLLAMA_API_KEY` | — | Optional; only when Ollama is behind an auth proxy |
| `CLAUDE_MEM_REFORMAT_RETRIES` | `1` | Bounded (0–3) re-prompts on malformed generation output; `0` disables. Applies to all providers. |
```
(If a `CLAUDE_MEM_SERVER_PROVIDER` row already exists, update its description rather than duplicating the row.)

- [ ] **Step 2: Build the bundle**

Run: `npm run build`
Expected: `✅ All build targets compiled successfully!`, exit 0.

- [ ] **Step 3: Verify the bundle embeds the new provider**

Run: `grep -c "llama3.1:8b\|providerLabel=\"ollama\"\|ollama" plugin/scripts/server-service.cjs`
Expected: `> 0` (the Ollama provider is bundled into the server runtime).

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/aws.md plugin/scripts/server-service.cjs
git commit -m "docs+build: document ollama provider + reformat guard env vars; rebuild bundle"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite without DB**

Run: `~/.bun/bin/bun test`
Expected: baseline pass count, 0 new failures (2301 pass / 0 fail baseline, plus the new non-DB provider/prompt tests).

- [ ] **Step 2: Full suite with DB**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test`
Expected: 0 failures (prior 2425 baseline + the new guard/provider tests).

- [ ] **Step 3: Confirm clean tree + no artifact drift**

Run: `npm run build && git status --short | grep -v '^??'`
Expected: empty (all artifacts in sync, nothing uncommitted).
