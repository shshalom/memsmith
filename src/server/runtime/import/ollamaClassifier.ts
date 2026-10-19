// SPDX-License-Identifier: Apache-2.0
// A TaxonomyClassifier backed by the local Ollama model. Prompts the model to
// pick ONE canonical label for the given content and parses a single token
// from the reply. Small and defensive: returns null on ANY failure (unreachable
// model, bad status, unparseable reply) so the resolver falls back to 'change'.
import { getOllamaConfig, type OllamaConfig } from '../../../shared/ollama-config.js';
import { OLLAMA_NUM_CTX } from '../../generation/providers/OllamaObservationProvider.js';
import type { TaxonomyClassifier } from './classifyObservationType.js';
import { logger } from '../../../utils/logger.js';

export function buildOllamaClassifier(
  candidateTypes?: string[],
  deps: { fetchImpl?: typeof fetch; config?: () => OllamaConfig } = {},
): TaxonomyClassifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const config = deps.config ?? getOllamaConfig;
  return {
    async classify(input: { content: string; sourceType: string }): Promise<string | null> {
      try {
        const { apiUrl, model, apiKey } = config();
        const candidates = (candidateTypes && candidateTypes.length > 0)
          ? candidateTypes
          : ['discovery', 'progress', 'blocker', 'decision', 'change'];
        const prompt =
          `Classify the following observation into exactly ONE of these labels: ${candidates.join(', ')}.\n` +
          `Reply with ONLY the single label word, lowercase, no punctuation or explanation.\n\n` +
          `Original type hint: ${input.sourceType}\n` +
          `Content:\n${input.content}`;

        // One deadline for both attempts so a slow model call can never wedge
        // the first-run import; an abort is caught below and returns null.
        const signal = AbortSignal.timeout(20000);
        const post = (sendThink: boolean) => fetchImpl(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(sendThink ? { think: false } : {}),
            options: { num_ctx: OLLAMA_NUM_CTX, temperature: 0 },
          }),
          signal,
        });
        let res = await post(true);
        // Ollama releases without thinking support reject the field outright.
        if (res.status === 400 && /think/i.test(await res.text())) res = await post(false);
        if (!res.ok) return null;
        const json = (await res.json()) as { message?: { content?: string } };
        const raw = json.message?.content;
        if (!raw || typeof raw !== 'string') return null;
        const match = raw.toLowerCase().match(/[a-z]+/);
        return match ? match[0] : null;
      } catch (error) {
        logger.warn(
          'SYSTEM',
          'ollama classify unreachable; falling back',
          {},
          error instanceof Error ? error : new Error(String(error)),
        );
        return null;
      }
    },
  };
}
