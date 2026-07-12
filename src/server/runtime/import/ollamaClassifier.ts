// SPDX-License-Identifier: Apache-2.0
// A TaxonomyClassifier backed by the local Ollama model. Prompts the model to
// pick ONE canonical label for the given content and parses a single token
// from the reply. Small and defensive: returns null on ANY failure (unreachable
// model, bad status, unparseable reply) so the resolver falls back to 'change'.
import { getOllamaConfig } from '../../../services/worker/OllamaProvider.js';
import type { TaxonomyClassifier } from './classifyObservationType.js';
import { logger } from '../../../utils/logger.js';

export function buildOllamaClassifier(candidateTypes?: string[]): TaxonomyClassifier {
  return {
    async classify(input: { content: string; sourceType: string }): Promise<string | null> {
      try {
        const { apiUrl, model, apiKey } = getOllamaConfig();
        const candidates = (candidateTypes && candidateTypes.length > 0)
          ? candidateTypes
          : ['discovery', 'progress', 'blocker', 'decision', 'change'];
        const prompt =
          `Classify the following observation into exactly ONE of these labels: ${candidates.join(', ')}.\n` +
          `Reply with ONLY the single label word, lowercase, no punctuation or explanation.\n\n` +
          `Original type hint: ${input.sourceType}\n` +
          `Content:\n${input.content}`;

        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            stream: false,
          }),
          // Hard timeout so a slow/contended model call can never wedge the
          // whole first-run import. On timeout the fetch aborts → caught below →
          // returns null → resolver falls back to 'change'.
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const raw = json.choices?.[0]?.message?.content;
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
