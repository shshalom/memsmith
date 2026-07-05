# Ollama Observation Provider + Shared Format Guard — Design

**Date:** 2026-07-05
**Status:** Approved (architecture); ready for implementation plan
**Area:** server-beta generation path (`src/server/generation/`)

## Goal

Let the self-hosted server generate observations with a **local Ollama model**
(default `llama3.1:8b`) instead of a metered cloud API, removing the
`ANTHROPIC_API_KEY` / per-token-billing dependency for the generation step. And
harden all providers against malformed LLM output with a bounded, best-effort
**reformat guard** — so smaller local models (more prone to format slips) don't
silently drop observations.

## Background (verified against the code)

- Server-beta generation providers live in `src/server/generation/providers/`
  and implement `ServerGenerationProvider` (`shared/types.ts`):
  `generate(context, signal?): Promise<{ rawText, tokensUsed?, providerLabel, modelId? }>`.
  Registered by `CLAUDE_MEM_SERVER_PROVIDER` in
  `instantiateServerGenerationProvider` (`src/server/runtime/create-server-service.ts`).
  Today: `claude` | `gemini` | `openrouter`.
- Ollama exposes an **OpenAI-compatible** `/v1/chat/completions` API, so
  `OpenRouterObservationProvider` is the correct analog. (Ollama already works
  *today* via OpenRouter + `CLAUDE_MEM_OPENROUTER_BASE_URL=http://localhost:11434/v1`;
  a dedicated provider is about ergonomics: keyless, clean label, sane defaults.)
- The prompt is built by the shared `buildServerGenerationPrompt(context, {mode})`
  (`shared/prompt-builder.ts`), which already instructs XML `<observation>` output.
- `parseAgentXml(raw)` (`src/sdk/parser.ts`) returns `{valid:false}` on malformed
  output; upstream turns that into a `parse_error` outcome. It is tolerant of
  prose-around-XML and whole-payload code fences, and treats `<skip_summary />`
  and empty text as **valid** (a legitimate "nothing to record").
- On `parse_error` today: `markGenerationFailed({classification:'parse_error',
  retryable:false})` → job terminal-fails (no BullMQ retry). This is idempotent
  (the `failed` terminal guard added earlier).
- Connection-refused / no-HTTP-response is classified `transient`
  (`error-classification.ts:123-129`) → BullMQ job retry. So a down Ollama
  daemon is a clean transient error, never mistaken for a format failure.
- `generate()` is called **once** per job today (`ProviderObservationGenerator.generateAndPersist`).

## Component A — OllamaObservationProvider

New file `src/server/generation/providers/OllamaObservationProvider.ts`, mirroring
`OpenRouterObservationProvider` (OpenAI-compatible POST to `/v1/chat/completions`,
body `{model, messages:[{role:'user',content:prompt}], temperature:0.3, max_tokens}`,
reads `data.choices[0].message.content`, classifies errors via
`classifyHttpProviderError({providerLabel:'ollama', ...})`).

Differences from OpenRouter:
- **`apiKey` optional.** Ollama is keyless. No `auth_invalid` throw when absent.
  If a key *is* supplied (some Ollama deploys sit behind an auth proxy), send it
  as `Authorization: Bearer <key>`; otherwise omit the header.
- **Default `baseUrl`** = `http://localhost:11434/v1`, override via
  `CLAUDE_MEM_OLLAMA_URL` (falls back to `CLAUDE_MEM_OPENROUTER_BASE_URL`-style
  resolution through `resolveOpenRouterChatCompletionsUrl`, which appends
  `/chat/completions`).
- **Default `model`** = `llama3.1:8b`, override via `CLAUDE_MEM_SERVER_MODEL`.
- **`providerLabel: 'ollama'`.**

Constructor opts: `{ apiKey?: string; model?: string; baseUrl?: string;
maxOutputTokens?: number; fetchImpl?: typeof fetch }`.

### Registration & the providerLabel union

- Widen the union in `shared/types.ts`:
  `providerLabel: 'claude' | 'gemini' | 'openrouter' | 'ollama'`.
- Add to `instantiateServerGenerationProvider` (`create-server-service.ts`):
  ```ts
  if (provider === 'ollama') {
    const apiKey = process.env.CLAUDE_MEM_OLLAMA_API_KEY ?? '';   // optional
    const opts: { apiKey?: string; model?: string; baseUrl?: string } = {};
    if (apiKey) opts.apiKey = apiKey;
    opts.model = process.env.CLAUDE_MEM_SERVER_MODEL ?? 'llama3.1:8b';
    const baseUrl = process.env.CLAUDE_MEM_OLLAMA_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OllamaObservationProvider(opts);
  }
  ```
  Note: NO `if (!apiKey) return null` guard (that guard is for keyed providers;
  Ollama is keyless, so an unset key must NOT disable it).
- Scope: **server-beta path only.** The worker-path/CLI `ProviderId` unions
  (`npx-cli`, `worker-types`, `SettingsRoutes` allowlist, telemetry scrub) are
  OUT of scope — this design adds a server-beta generation provider, not a
  worker/installer provider. (Documented so a reviewer doesn't flag the missing
  installer entry as a gap.)

## Component B — Shared reformat guard (in generateAndPersist)

The guard lives once in `ProviderObservationGenerator.generateAndPersist`
(`src/server/generation/ProviderObservationGenerator.ts`), the single place that
already calls `generate()` and owns the downstream parse. Providers stay thin.

### Interface change

`ServerGenerationProvider.generate` gains an optional third arg:
```ts
generate(
  context: ServerGenerationContext,
  signal?: AbortSignal,
  opts?: { reformatReason?: string },
): Promise<ServerGenerationResult>;
```
Each provider passes `opts?.reformatReason` into
`buildServerGenerationPrompt(context, { mode, reformatReason })`. All providers
inherit the guard for free via the shared builder. Providers that ignore the arg
(back-compat) still compile — the arg is optional.

### buildServerGenerationPrompt addendum

`buildServerGenerationPrompt` gains `options.reformatReason?: string`. When set,
it appends a strict addendum after the normal instructions:

> "Your previous response could not be parsed (`<reason>`). Output ONLY the XML
> observation block(s) described above — no prose before or after, no markdown
> code fences, no explanation. If nothing is worth recording, output exactly
> `<skip_summary />`."

### Guard flow (in generateAndPersist)

```
let rawText = (await provider.generate(context, signal)).rawText   // + keep full result for tokens/model
const maxReformat = clamp(Number(env.CLAUDE_MEM_REFORMAT_RETRIES ?? 1), 0, 3)
let attempts = 0
while (attempts < maxReformat && !parseAgentXml(rawText).valid) {
  attempts++
  const reason = describeParseFailure(rawText)   // short machine string
  result = await provider.generate(context, signal, { reformatReason: reason })
  rawText = result.rawText
}
// fall through UNCHANGED: processGeneratedResponse(result with final rawText)
//   valid  -> persist
//   invalid -> parse_error -> markGenerationFailed(retryable:false)   [today's behavior]
```

Notes:
- The guard's `parseAgentXml` call is **only** to decide whether to retry. The
  final `rawText` still flows through the unchanged `processGeneratedResponse`,
  so persistence, `generation_key` idempotency, and the `parse_error` terminal
  path are byte-identical to today.
- `<skip_summary />` and empty `rawText` parse as **valid** → guard never retries
  a legitimate skip.
- The guard uses the *latest* `generate()` result object (for `tokensUsed` /
  `modelId`), not just the first.

### Error handling (format failure vs provider error)

- **Provider error** (`generate()` THROWS a `ServerClassifiedProviderError`):
  the guard does not catch it — the throw propagates to generateAndPersist's
  existing catch → real classification (`transient`/`rate_limit` → job retry;
  else fail). A reformat-retry call that itself throws propagates the same way.
  Down Ollama daemon = `transient` (status undefined path) → job retry. Unchanged.
- **Format failure** (`generate()` RETURNS malformed text): the only trigger for
  the reformat guard.
- Worst case for the guard: same `parse_error`→fail outcome as today, after ≤N
  extra provider calls. It can never make the outcome worse.

### Config / escape hatch

- `CLAUDE_MEM_REFORMAT_RETRIES` default `1`, clamped `[0,3]`. `0` fully disables
  the guard (exact pre-guard behavior), mirroring the `CLAUDE_MEM_SEARCH_HYBRID=0`
  escape-hatch pattern.
- Retries respect the same `AbortSignal` (cancelled/timed-out job spins no extra
  calls).

## Testing

1. **OllamaObservationProvider** (`tests/server/generation/providers.test.ts`,
   mirror the OpenRouter suite — inject `fetchImpl`, use `CapturingFetch`):
   - Happy path: parses `choices[0].message.content` → `rawText`, `tokensUsed`,
     `providerLabel === 'ollama'`, `modelId`.
   - Default URL `http://localhost:11434/v1/chat/completions` when no baseUrl.
   - `CLAUDE_MEM_OLLAMA_URL` override honored.
   - Keyless construction succeeds (no throw); no `Authorization` header sent
     when no key; `Authorization: Bearer` sent when a key is supplied.
   - Default model `llama3.1:8b` in the request body; `CLAUDE_MEM_SERVER_MODEL`
     override honored.
   - Connection-refused (fetch throws, status undefined) → `transient`.
2. **Registration** (`create-server-service` test or a targeted unit): provider
   `'ollama'` instantiates without an API key; `'ollama'` with `CLAUDE_MEM_SERVER_MODEL`
   uses that model.
3. **Prompt addendum** (`prompt-builder` test): `reformatReason` set → output
   contains the strict "ONLY the XML … no prose … no code fences" language and
   the reason; unset → identical to today (no addendum).
4. **Reformat guard** (`provider-observation-generator` test): a stub provider
   that returns malformed text on call 1 and valid XML on call 2 → observation
   persists, provider called twice, job completes. A stub that returns malformed
   text every time with `CLAUDE_MEM_REFORMAT_RETRIES=1` → provider called twice,
   job ends `parse_error`→failed (unchanged terminal outcome). With
   `CLAUDE_MEM_REFORMAT_RETRIES=0` → provider called once, fails (guard disabled).
   A stub that THROWS a transient error on the reformat retry → propagates as a
   provider error (job retryable), not swallowed as a format failure.
5. Full suite green with and without `CLAUDE_MEM_TEST_POSTGRES_URL`.

## Out of scope (YAGNI / deferred)

- Dedicated "repair" prompt that feeds the model its own bad output (heavier;
  revisit only if one strict re-prompt proves insufficient in a stress test).
- Flipping `parse_error` to job-level `retryable:true` (keeps today's terminal
  behavior; measure real failure rate first).
- Worker-mode / installer / CLI `--provider ollama` wiring (server-beta only).
- Embedding via Ollama (this is about the *generation* provider; embeddings stay
  on the local all-MiniLM path).

## Post-ship validation

Run a stress test against a real local `llama3.1:8b`: submit N varied events,
measure the parse-failure rate WITH the guard (retries=1) vs WITHOUT (retries=0),
to decide whether to raise the retry bound or add the dedicated-repair path.
