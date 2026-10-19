# Haiku 5.5 default with local Gemma failover: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Haiku 5.5 the default observation generator, with automatic failover to a local `gemma4:12b` through Ollama, and make the Ollama provider light enough to serve as that backup.

**Architecture:** A `FailoverGenerationProvider` decorator wraps the primary provider and a local Ollama fallback. `GenerationProviderHolder` builds it per job from two new settings, so failover is live-switchable like the provider itself. The Ollama provider moves from the OpenAI-compatible `/v1` endpoint to Ollama's native `/api/chat`, which is the only way to pin `num_ctx` and disable thinking.

**Tech Stack:** TypeScript, Bun test runner, `@clack/prompts` (installer), Ollama native API, Anthropic Messages API.

**Spec:** The design section below, approved in the session of 2026-10-19. Evidence: `bench/model-bench/` (Haiku 5.5: 96% usable, 4.21/5, $1.04 per 1,000 events; `gemma4:12b`: best local model, 56% usable, 9.7 GB at `num_ctx` 20480).

## Design

1. Defaults: provider `claude`, model `claude-haiku-5-5`, Ollama model `gemma4:12b`.
2. Failover: Claude first; on any provider error, the same job goes to local Ollama `gemma4:12b`. If the fallback also fails, the primary's error is rethrown, so retry classification is unchanged. After a primary failure, jobs go to the fallback first for a 5-minute cooldown. No Anthropic key means fallback only. Failover is never local-to-cloud.
3. Settings: `fallback` (`ollama` | `none`, default `ollama`), `fallbackModel` (default `gemma4:12b`).
4. Ollama provider: native `/api/chat` with `think: false` and `options.num_ctx: 20480`.
5. Installer: after choosing Claude, ask "Install a local backup for outages? (8 GB)" with Yes preselected; Yes pulls `gemma4:12b`.
6. Existing installs: never switched silently. At server boot, an install whose settings file lacks `MEMSMITH_SERVER_PROVIDER` is pinned to its current effective setup (Ollama). `memsmith update` offers the switch once, in a TTY only.

## Global constraints

- Model IDs, verbatim: `claude-haiku-5-5`, `gemma4:12b`.
- Ollama `num_ctx`: `20480` (longest production prompt ≈ 16,138 tokens + 4,096 output tokens).
- Failover cooldown: `300_000` ms.
- Setting env names: `MEMSMITH_SERVER_FALLBACK`, `MEMSMITH_SERVER_FALLBACK_MODEL`.
- Comments only where the code cannot say it (user rule). No narration comments.
- User-facing text follows the Google developer documentation style.
- Every user-facing change gets a line under `## [Unreleased]` in `CHANGELOG.md`.

## Review focus

1. A revoked or out-of-credit Anthropic key: every job must still complete on the fallback, and only one primary attempt is made per cooldown window. Test in Task 2.
2. An aborted job (`signal.aborted`): must not fail over; the abort propagates. Test in Task 2.
3. Fallback model not pulled or Ollama absent: both fail, and the primary's classified error is what the generator sees, so a transient Claude outage still retries. Test in Task 2.
4. An existing install with only legacy keys (`MEMSMITH_PROVIDER=ollama`) updating to this version: it must stay on Ollama with its current model, never silently move to the cloud. Test in Task 3.
5. `MEMSMITH_OLLAMA_URL` values in the wild (`http://localhost:11434/v1`, a bare origin, a proxy path): all must reach the native `/api/chat`. Test in Task 1.

---

### Task 1: Ollama provider on the native API

**Files:**
- Modify: `src/server/generation/providers/OllamaObservationProvider.ts`
- Test: `tests/server/generation/providers.test.ts` (describe `OllamaObservationProvider`)

**Interfaces:**
- Produces: `export function resolveOllamaChatUrl(baseUrl: string): string`; `export const OLLAMA_NUM_CTX = 20480`; `DEFAULT_MODEL = 'gemma4:12b'`.

- [ ] **Step 1: Update and add failing tests.** Existing URL assertions change to the native endpoint. New tests:

```ts
it('posts to the native chat endpoint with num_ctx pinned and thinking off', async () => {
  // CapturingFetch returning { message: { content: '<skip_summary />' }, prompt_eval_count: 30, eval_count: 12 }
  expect(capture.lastUrl).toBe('http://localhost:11434/api/chat');
  expect(body.model).toBe('gemma4:12b');
  expect(body.stream).toBe(false);
  expect(body.think).toBe(false);
  expect(body.options).toMatchObject({ num_ctx: 20480, temperature: 0.3, num_predict: 4096 });
  expect(result.tokensUsed).toBe(42);
});
it('resolveOllamaChatUrl maps every configured base URL form to /api/chat', () => {
  expect(resolveOllamaChatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/api/chat');
  expect(resolveOllamaChatUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/api/chat');
  expect(resolveOllamaChatUrl('http://ollama.internal:11434')).toBe('http://ollama.internal:11434/api/chat');
  expect(resolveOllamaChatUrl('https://proxy.example.com/ollama/v1')).toBe('https://proxy.example.com/ollama/api/chat');
  expect(resolveOllamaChatUrl('http://localhost:11434/v1/chat/completions')).toBe('http://localhost:11434/api/chat');
});
it('retries once without think when the model rejects think control', async () => {
  // first response: 400 { error: 'model does not support thinking' }; second: 200
  expect(bodies[1]).not.toHaveProperty('think');
});
```

- [ ] **Step 2: Run** `bun test tests/server/generation/providers.test.ts -t Ollama`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** Replace `postChatCompletion` with a native call; parse `message.content` and `prompt_eval_count + eval_count`; a JSON `{ error: string }` body goes through `classifyHttpProviderError`. Keep `ensureRunning()` unchanged. The "unsupported think" retry triggers only on HTTP 400 whose body matches `/think/i`. One comment on `OLLAMA_NUM_CTX` stating why 20480 (Ollama otherwise sizes the context from VRAM, up to 256k for `gemma4:12b`, which multiplies RAM).
- [ ] **Step 4: Run** the Ollama tests and `bun test tests/server/generation/`. Expected: all pass.
- [ ] **Step 5: Commit** `fix(ollama): use native chat API with num_ctx 20480 and thinking off`.

### Task 2: FailoverGenerationProvider

**Files:**
- Create: `src/server/generation/providers/FailoverGenerationProvider.ts`
- Test: `tests/server/generation/failover-provider.test.ts`

**Interfaces:**
- Consumes: `ServerGenerationProvider`, `ServerGenerationContext`, `ServerGenerationResult` from `providers/shared/types.ts`.
- Produces:
```ts
export const FAILOVER_COOLDOWN_MS = 300_000;
export class FailoverGenerationProvider implements ServerGenerationProvider {
  constructor(opts: { primary: ServerGenerationProvider | null; fallback: ServerGenerationProvider; cooldownMs?: number; now?: () => number });
  readonly providerLabel: ServerGenerationProvider['providerLabel']; // primary's label, else fallback's
  generate(context, signal?, opts?): Promise<ServerGenerationResult>;
}
```

- [ ] **Step 1: Write failing tests** with stub providers that record calls (fake clock through `now`):
  - `uses the primary when it succeeds` (fallback never called; result `providerLabel === 'claude'`).
  - `sends the same job to the fallback when the primary throws` (result `providerLabel === 'ollama'`; fallback received the same context and `opts.reformatReason`).
  - `rethrows the primary error when both fail` (the thrown object `toBe` the primary's `ServerClassifiedProviderError` with kind `transient`).
  - `skips the primary during the cooldown, then retries it` (after one failure: next call at +1 min hits only the fallback; a call at +5 min + 1 ms tries the primary again).
  - `in cooldown, falls back to the primary when the fallback fails` (primary recovered → result from primary).
  - `uses only the fallback when there is no primary` (`primary: null`).
  - `does not fail over when the job was aborted` (aborted `AbortController`, primary throws → fallback not called, error propagates).
- [ ] **Step 2: Run** `bun test tests/server/generation/failover-provider.test.ts`. Expected: fails (module missing).
- [ ] **Step 3: Implement.** Log a `logger.warn('SYSTEM', ...)` on entering cooldown, with both labels and the primary error kind; no log per job during cooldown.
- [ ] **Step 4: Run** the test file. Expected: all pass.
- [ ] **Step 5: Commit** `feat(generation): add local failover provider`.

### Task 3: Settings, defaults, wiring, and legacy pinning

**Files:**
- Modify: `src/server/settings/settingKeys.ts` (`provider` default `claude`; `model` default `claude-haiku-5-5`; help text examples; new `fallback` and `fallbackModel` entries)
- Modify: `src/server/settings/SettingsResolver.ts` (accessors `fallback(teamId)`, `fallbackModel(teamId)`)
- Modify: `src/server/runtime/resolve-generation-provider.ts` (`DEFAULT_GENERATION_PROVIDER = 'claude'`; rewrite its header comment to the new reason)
- Modify: `src/server/runtime/create-server-service.ts` (new `buildGenerationProvider`; boot provider at `:621-628` and the Ollama default at `:671` use it)
- Modify: `src/server/generation/GenerationProviderHolder.ts` (resolve the four settings; cache key includes all four; default instantiate is `buildGenerationProvider`)
- Create: `src/server/settings/pin-legacy-generation-settings.ts`, called once at server boot before the resolver is built (`create-server-service.ts` near `:566` and `ServerService.ts` near `:311`)
- Modify defaults: `ClaudeObservationProvider.ts:22` (`DEFAULT_SERVER_CLAUDE_MODEL = 'claude-haiku-5-5'`), `SettingsDefaultsManager.ts:133,148`, `ollama-config.ts:19`, `cli/handlers/generation-readiness.ts:13`, `ui/viewer/constants/settings.ts:2,14`, `shared/setup-state.ts:57`
- Test: `tests/server/generation/provider-holder-failover.test.ts`, `tests/server/settings/pin-legacy-generation-settings.test.ts`, plus updating any existing test that asserts the old defaults

**Interfaces:**
- Consumes: `FailoverGenerationProvider` (Task 2), `instantiateServerGenerationProvider` (existing).
- Produces:
```ts
export interface GenerationProviderSpec { provider: string; model?: string; fallback: string; fallbackModel: string }
export function buildGenerationProvider(spec: GenerationProviderSpec, sources?: GenerationConfigSources): ServerGenerationProvider | null;
export function legacyGenerationPins(settings: Record<string, unknown>, env: Record<string, string | undefined>): Record<string, string> | null;
```
- `buildGenerationProvider` rules: provider `ollama` or fallback `none` → the plain provider. Otherwise `new FailoverGenerationProvider({ primary: instantiate(provider, model), fallback: instantiate('ollama', fallbackModel) })`.
- `legacyGenerationPins` returns `{ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: <MEMSMITH_OLLAMA_MODEL || 'qwen2.5:14b'> }` when the settings object has at least one `MEMSMITH_` key, has no `MEMSMITH_SERVER_PROVIDER`, and env has no `MEMSMITH_SERVER_PROVIDER`; otherwise `null`. The boot call writes the pins with `mergeSettings` and logs once.

- [ ] **Step 1: Write failing tests:**
  - `legacy install with only MEMSMITH_PROVIDER=ollama and MEMSMITH_OLLAMA_MODEL=qwen2.5:14b is pinned to ollama/qwen2.5:14b`.
  - `install that already set MEMSMITH_SERVER_PROVIDER is not pinned`; `env override is not pinned`; `empty settings (fresh machine) is not pinned`.
  - `holder builds Claude with an Ollama gemma4:12b fallback by default` (stub instantiate records `('claude','claude-haiku-5-5')` and `('ollama','gemma4:12b')`; the result is a `FailoverGenerationProvider`).
  - `holder builds plain Ollama when the provider is ollama`; `holder builds plain Claude when fallback is none`.
  - `holder with no Anthropic key still returns a provider that generates through the fallback`.
  - `holder keeps one instance (and its cooldown) while settings are unchanged`.
- [ ] **Step 2: Run** the new test files. Expected: fail.
- [ ] **Step 3: Implement**, including the default changes listed under **Files**.
- [ ] **Step 4: Run** `bun test tests/server/`. Expected: all pass, with old-default assertions updated rather than deleted.
- [ ] **Step 5: Commit** `feat(generation): default to Claude Haiku 5.5 with Gemma failover`.

### Task 4: Installer recommends Haiku 5.5 and offers the local backup

**Files:**
- Modify: `src/npx-cli/install/generation-provider.ts` (`DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5'`, `DEFAULT_OLLAMA_MODEL = 'gemma4:12b'`; choices order Claude first: label `Claude Haiku 5.5 (recommended)`, hint `needs an Anthropic API key; about $1 per 1,000 observations`; Ollama label `Ollama — local and private, no API key`, hint `runs on this machine; downloads an 8 GB model`)
- Modify: `src/npx-cli/install/provider-prompt.ts` (`ProviderPromptIO.offerLocalBackup(): Promise<boolean>`; claude branch calls it after `claudeModel`; `ProviderOutcome` carries `localBackup: boolean`; `ollamaSetupPlan` returns a pull of `gemma4:12b` when `localBackup` is true)
- Modify: `src/npx-cli/commands/install.ts` (`CLAUDE_MODEL_CHOICES` gains `claude-haiku-5-5` first as recommended, `claude-sonnet-5-5` second; `offerLocalBackup` is `p.confirm({ message: 'Install a local backup for outages? (8 GB)', initialValue: true })`; Yes also writes `MEMSMITH_SERVER_FALLBACK=ollama`, No writes `none`)
- Modify: `src/npx-cli/install/ollama-setup.ts:43` (size label for `gemma4:12b`: `8 GB`)
- Test: `tests/npx-cli/provider-prompt.test.ts`, `tests/npx-cli/generation-provider.test.ts`

- [ ] **Step 1: Write failing tests:** `claude choice asks for the local backup and plans a gemma4:12b pull on yes`; `declining the backup saves fallback none and plans no pull`; `non-interactive claude install (--provider claude) does not prompt and keeps the backup off unless --local-backup is passed` (reuse the existing flag-parsing pattern in `install.ts`).
- [ ] **Step 2: Run** `bun test tests/npx-cli/`. Expected: new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test tests/npx-cli/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(install): recommend Claude Haiku 5.5 and offer a local Gemma backup`.

### Task 5: `memsmith update` offers the switch once

**Files:**
- Modify: `src/npx-cli/commands/update.ts` (new optional deps `isInteractive(): boolean`, `confirm(message): Promise<boolean>`, `switchToHaiku(): Promise<void>`; one offer after the restart check)
- Modify: `src/npx-cli/commands/install.ts` (export the pieces `switchToHaiku` reuses: `promptAnthropicApiKey`, Ollama backup setup)
- Test: `tests/npx-cli/update.test.ts`

**Interfaces:**
- The offer runs only when interactive, the effective provider in settings is `ollama`, and `MEMSMITH_GENERATION_SWITCH_OFFERED` is unset. Message: `Switch memory generation to Claude Haiku 5.5, with your local model as the backup? It needs an Anthropic API key and costs about $1 per 1,000 observations.` Either answer writes `MEMSMITH_GENERATION_SWITCH_OFFERED=1`. Yes runs `switchToHaiku`: collect the key if missing, write `MEMSMITH_SERVER_PROVIDER=claude`, `MEMSMITH_SERVER_MODEL=claude-haiku-5-5`, `MEMSMITH_SERVER_FALLBACK=ollama`, `MEMSMITH_SERVER_FALLBACK_MODEL=gemma4:12b`, and offer the `gemma4:12b` pull. Non-interactive runs print one line: `Tip: run memsmith install to switch to Claude Haiku 5.5 with a local backup.`

- [ ] **Step 1: Write failing tests:** `offers the switch once on an interactive update of an ollama install`; `does not offer again after an answer`; `does not offer on a claude install`; `non-interactive update prints the tip and never prompts`; `declining changes no generation settings`.
- [ ] **Step 2: Run** `bun test tests/npx-cli/update.test.ts`. Expected: new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test tests/npx-cli/`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(update): offer the switch to Claude Haiku 5.5 once`.

### Task 6: Docs, changelog, build, and live check

**Files:**
- Modify: `README.md:57`, `docs/public/configuration.mdx:19-21`, `docs/public/installation.mdx:23`, `docs/public/platform-integration.mdx:51`, `docs/public/architecture/hooks.mdx:864` (new defaults; a short "Local backup" section in `configuration.mdx` covering `MEMSMITH_SERVER_FALLBACK`, `MEMSMITH_SERVER_FALLBACK_MODEL`, the cooldown, and that failover is never local-to-cloud)
- Modify: `CHANGELOG.md` (`## [Unreleased]`: Changed, Added, Fixed entries)
- Create: `bench/model-bench/README.md` (how to run; results table from `results/REPORT.md`; caveats: judge family, contention on latency, Gemma RAM measured from wired memory)

- [ ] **Step 1:** Update docs and changelog.
- [ ] **Step 2: Run** `bun test` and `npm run build-and-sync`. Expected: tests pass; build succeeds.
- [ ] **Step 3: Live check** on this machine with `memsmith restart`: with the key present, a new observation's metadata shows `provider: claude`, `model: claude-haiku-5-5`; with `MEMSMITH_ANTHROPIC_API_KEY=invalid` exported for a restart, the next observation shows `provider: ollama`, `model: gemma4:12b`, and `ollama ps` shows a context of 20480.
- [ ] **Step 4: Commit** `docs: Haiku 5.5 default, Gemma backup, and model bench results`.
