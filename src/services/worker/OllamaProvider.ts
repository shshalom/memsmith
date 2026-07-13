// SPDX-License-Identifier: Apache-2.0

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { withRetry, parseRetryAfterMs } from './retry.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';

/**
 * Classify an Ollama fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 */
export function classifyOllamaError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;

  if (status === 429) {
    return new ClassifiedProviderError(
      'Ollama rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `Ollama auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `Ollama bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `Ollama upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient (e.g. ECONNREFUSED when Ollama isn't running).
  if (status === undefined) {
    return new ClassifiedProviderError(
      `Ollama network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `Ollama API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OllamaResponse {
  /** The model that actually served the request. */
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

import { getOllamaConfig, type OllamaConfig } from '../../shared/ollama-config.js';
export { getOllamaConfig, type OllamaConfig };

export class OllamaProvider extends OpenAICompatibleProvider<OllamaConfig> {
  protected readonly providerName = 'Ollama';
  protected readonly syntheticIdPrefix = 'ollama';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): OllamaConfig {
    return getOllamaConfig();
  }

  protected missingApiKeyError(): Error {
    return new Error('Ollama requires a reachable MEMSMITH_OLLAMA_URL (no API key needed)');
  }

  protected prepareSessionExtras(session: ActiveSession, _config: OllamaConfig): void {
    session.endpointClass = 'custom';
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Real usage only, both sides or nothing.
   */
  protected buildLastUsage(result: ProviderQueryResult): ActiveSession['lastUsage'] {
    if (typeof result.inputTokens !== 'number' || typeof result.outputTokens !== 'number') {
      return null;
    }
    return {
      input: result.inputTokens,
      output: result.outputTokens,
    };
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  protected async query(history: ConversationMessage[], config: OllamaConfig): Promise<ProviderQueryResult> {
    return this.queryOllamaMultiTurn(history, config.model, config.apiUrl);
  }

  /** POST the chat-completions request to Ollama (no Authorization header — keyless). */
  private fetchChatCompletion(
    apiUrl: string,
    model: string,
    messages: OpenAIMessage[],
    attemptSignal: AbortSignal
  ): Promise<Response> {
    return fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
      signal: attemptSignal,
    });
  }

  private async queryOllamaMultiTurn(
    history: ConversationMessage[],
    model: string,
    apiUrl: string,
  ): Promise<ProviderQueryResult> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(history.map(m => m.content).join(''));

    logger.debug('SDK', `Querying Ollama multi-turn (${model})`, {
      turns: history.length,
      totalChars,
      estimatedTokens
    });

    const data = await withRetry<OllamaResponse>(async (attemptSignal) => {
      let response: Response;
      try {
        response = await this.fetchChatCompletion(apiUrl, model, messages, attemptSignal);
      } catch (networkError: unknown) {
        const err = networkError instanceof Error ? networkError : new Error(String(networkError));
        throw classifyOllamaError({ cause: err });
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw classifyOllamaError({
          status: response.status,
          bodyText: errorText,
          headers: response.headers,
          cause: new Error(`Ollama API error: ${response.status} - ${errorText}`),
        });
      }

      const responseData = await response.json() as OllamaResponse;

      if (responseData.error) {
        throw classifyOllamaError({
          status: response.status,
          bodyText: `${responseData.error.code} ${responseData.error.message ?? ''}`,
          headers: response.headers,
          cause: new Error(`Ollama API error: ${responseData.error.code} - ${responseData.error.message}`),
        });
      }

      return responseData;
    }, { label: `Ollama ${model}` });

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from Ollama');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;
    const realInputTokens = data.usage?.prompt_tokens;
    const realOutputTokens = data.usage?.completion_tokens;
    const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

    if (tokensUsed) {
      logger.info('SDK', 'Ollama API usage', {
        model: servedModel ?? model,
        inputTokens: realInputTokens || 0,
        outputTokens: realOutputTokens || 0,
        totalTokens: tokensUsed,
        messagesInContext: history.length
      });
    }

    return { content, tokensUsed, inputTokens: realInputTokens, outputTokens: realOutputTokens, servedModel };
  }
}


export function isOllamaAvailable(): boolean {
  return true; // local + keyless — always available
}

export function isOllamaSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.MEMSMITH_PROVIDER === 'ollama';
}
