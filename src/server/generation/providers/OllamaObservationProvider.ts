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
