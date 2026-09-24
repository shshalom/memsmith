// SPDX-License-Identifier: Apache-2.0

import { resolveOpenRouterChatCompletionsUrl } from '../../../shared/openrouter-base-url.js';
import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import { ensureOllamaRunning, ollamaCanGenerate, resolveAutostartEnabled } from './ollama-ensure-running.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

export const DEFAULT_MODEL = 'llama3.1:8b';
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

  /**
   * Best-effort: confirm ollama is listening, starting it if it is not.
   *
   * Deliberately swallows everything. If this cannot help, the request below
   * fails as it always did — classified transient and retried. This must never
   * turn a recoverable outage into a lost job.
   */
  private async ensureRunning(): Promise<void> {
    try {
      // The OpenAI-compatible apiUrl ends in /v1/chat/completions; the liveness
      // endpoint is /api/tags on the same origin.
      const origin = new URL(this.apiUrl).origin;
      await ensureOllamaRunning({
        // READINESS, not liveness. This asked `GET /api/tags` and took r.ok as
        // health — which only proves the HTTP daemon answers. Ollama served
        // /api/tags with a 200 and the full model list for 6.4 days while every
        // generate returned 500 ("failed to initialize the Metal library"), so
        // the probe passed, recovery declared success, and 1,187,422 jobs
        // failed in a row. The recovery slept through the outage it exists for.
        probe: () => ollamaCanGenerate({
          origin,
          model: this.model,
          fetchImpl: this.fetchImpl,
        }),
        spawn: async () => {
          const { spawn } = await import('child_process');
          // KILL FIRST. The original only handled an ABSENT ollama, so
          // `ollama serve` against a live-but-wedged daemon just fails to bind
          // and changes nothing — which is why the Metal failure never
          // self-healed. A wedged backend needs the process replaced, and the
          // readiness probe above is what distinguishes the two cases.
          //
          // Best-effort and non-fatal: no ollama to kill is the normal
          // cold-start path.
          try {
            const killer = spawn('pkill', ['-x', 'ollama'], { stdio: 'ignore' });
            await new Promise(resolve => killer.on('exit', resolve).on('error', resolve));
            await new Promise(resolve => setTimeout(resolve, 1_000));
          } catch { /* nothing running is fine */ }
          // Detached + ignored stdio so the server outlives this process and
          // cannot block on an unread pipe.
          const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
          child.unref();
          // Give it a moment to bind before the confirming probe.
          await new Promise(resolve => setTimeout(resolve, 3_000));
        },
        now: () => Date.now(),
        autostart: resolveAutostartEnabled(process.env),
      });
    } catch {
      // Fall through to the normal request path.
    }
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

    // Check ollama is alive AT THE POINT OF USE, and start it if not.
    //
    // Ollama died on a reboot and nothing restarted it: generation stopped for
    // ~15 hours while thousands of jobs piled up. Polling would notice
    // eventually; checking here notices immediately, because this is the exact
    // moment the provider is needed — and it can recover rather than just report.
    //
    // Single-flighted and backed off inside ensureOllamaRunning, so four
    // concurrent jobs spawn one server and a broken install does not become a
    // spawn loop. A false result falls through to the normal request path, whose
    // failure is classified transient and retried — never silently dropped.
    await this.ensureRunning();

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
