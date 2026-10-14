// src/server/generation/provider-complete.ts
// SPDX-License-Identifier: Apache-2.0
import type { ServerGenerationProvider } from './providers/shared/types.js';
import { logger } from '../../utils/logger.js';
// Reuse each provider's real default model (single source of truth) — do NOT
// duplicate literals here. A guessed 'claude-3-5-haiku-latest' 404'd live
// against the Anthropic API (same class as prior fix #2554); importing the
// constants keeps this branch in lockstep with the provider classes.
import { DEFAULT_SERVER_CLAUDE_MODEL } from './providers/ClaudeObservationProvider.js';
import { DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from './providers/GeminiObservationProvider.js';
import { DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL } from './providers/OpenRouterObservationProvider.js';
import { DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL } from './providers/OllamaObservationProvider.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../shared/openrouter-base-url.js';
import {
  loadGenerationConfigSources,
  resolveGenerationCredentials,
  type GenerationConfigSources,
} from '../runtime/generation-credentials.js';

interface Deps { fetchImpl?: typeof fetch; sources?: GenerationConfigSources }

// Minimal plain chat-completion using the user's configured provider — for the
// record-intent Layer-2 backstop. Credentials come from the same resolver as
// generation, so both read the same keys in the same order.
// Fail-open: any error / non-ok / empty → null.
export async function providerComplete(
  input: { provider: ServerGenerationProvider; system: string; user: string },
  deps: Deps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.MEMSMITH_SERVER_MODEL;
  try {
    const { apiKey, baseUrl } = resolveGenerationCredentials(
      input.provider.providerLabel,
      deps.sources ?? loadGenerationConfigSources(),
    );
    switch (input.provider.providerLabel) {
      case 'ollama': {
        const url = ollamaChatCompletionsUrl(baseUrl ?? process.env.OLLAMA_URL ?? 'http://localhost:11434/v1');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return await openaiChat(fetchImpl, url, headers, model ?? OLLAMA_DEFAULT_MODEL, input.system, input.user);
      }
      case 'openrouter': {
        if (!apiKey) return null;
        const base = (baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
        const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
        return await openaiChat(fetchImpl, url, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, model ?? OPENROUTER_DEFAULT_MODEL, input.system, input.user);
      }
      case 'claude': {
        if (!apiKey) return null;
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: model ?? DEFAULT_SERVER_CLAUDE_MODEL,
            max_tokens: 1024,
            system: input.system,
            messages: [{ role: 'user', content: input.user }],
          }),
        });
        if (!res.ok) return null;
        const data = await res.json() as { content?: Array<{ type?: string; text?: string }> };
        const text = (data.content ?? []).filter(b => b?.type === 'text').map(b => b?.text ?? '').join('').trim();
        return text || null;
      }
      case 'gemini': {
        if (!apiKey) return null;
        const m = model ?? GEMINI_DEFAULT_MODEL;
        const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: 'user', parts: [{ text: input.user }] }],
          }),
        });
        if (!res.ok) return null;
        const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const text = (data.candidates?.[0]?.content?.parts ?? []).map(p => p?.text ?? '').join('').trim();
        return text || null;
      }
      default:
        return null;
    }
  } catch (error) {
    logger.debug('SYSTEM', 'providerComplete failed (fail-open)', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

// OLLAMA_URL is often a bare origin; Ollama serves the OpenAI API under /v1.
function ollamaChatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/$/, '');
  return resolveOpenRouterChatCompletionsUrl(new URL(trimmed).pathname === '/' ? `${trimmed}/v1` : trimmed);
}

async function openaiChat(
  fetchImpl: typeof fetch, url: string, headers: Record<string, string>,
  model: string, system: string, user: string,
): Promise<string | null> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  return text || null;
}
