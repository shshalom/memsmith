// src/server/generation/provider-complete.ts
import type { ServerGenerationProvider } from './providers/shared/types.js';
import { logger } from '../../utils/logger.js';

interface Deps { fetchImpl?: typeof fetch }

// Minimal plain chat-completion using the user's configured provider — for the
// record-intent Layer-2 backstop. Reads API key / model / base URL from env,
// keyed by providerLabel, mirroring instantiateServerGenerationProvider
// (create-server-service.ts). Fail-open: any error / non-ok / empty → null.
export async function providerComplete(
  input: { provider: ServerGenerationProvider; system: string; user: string },
  deps: Deps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.MEMSMITH_SERVER_MODEL;
  try {
    switch (input.provider.providerLabel) {
      case 'ollama': {
        const base = (process.env.MEMSMITH_OLLAMA_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
        const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
        const apiKey = process.env.MEMSMITH_OLLAMA_API_KEY;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return await openaiChat(fetchImpl, url, headers, model ?? 'llama3.1:8b', input.system, input.user);
      }
      case 'openrouter': {
        const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.MEMSMITH_OPENROUTER_API_KEY ?? '';
        if (!apiKey) return null;
        const rawBase = process.env.MEMSMITH_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
        const base = rawBase.replace(/\/$/, '');
        const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
        return await openaiChat(fetchImpl, url, { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, model ?? 'anthropic/claude-3.5-sonnet', input.system, input.user);
      }
      case 'claude': {
        const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.MEMSMITH_ANTHROPIC_API_KEY ?? '';
        if (!apiKey) return null;
        const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: model ?? 'claude-3-5-haiku-latest',
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
        const apiKey = process.env.GEMINI_API_KEY ?? process.env.MEMSMITH_GEMINI_API_KEY ?? '';
        if (!apiKey) return null;
        const m = model ?? 'gemini-2.5-flash';
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
