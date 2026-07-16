// src/server/generation/provider-complete.ts
// SPDX-License-Identifier: Apache-2.0
import type { ServerGenerationProvider } from './providers/shared/types.js';
import { logger } from '../../utils/logger.js';

interface Deps { fetchImpl?: typeof fetch }

// Minimal plain chat-completion using the resolved provider — for the record-
// intent backstop's classify+compose. Deliberately NOT the obs-XML generate()
// path. Never throws; returns null on any failure (fail-open → Layer-1-only).
// Ollama first (local dogfood default); unsupported providers return null.
export async function providerComplete(
  input: { provider: ServerGenerationProvider; system: string; user: string },
  deps: Deps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (input.provider.providerLabel !== 'ollama') return null; // extend later
    const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
    const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
    const model = process.env.MEMSMITH_SERVER_MODEL ?? 'llama3.1:8b';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    logger.debug('SYSTEM', 'providerComplete failed (fail-open)', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
