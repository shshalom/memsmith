// SPDX-License-Identifier: Apache-2.0
// Neutral home for Ollama connection config, shared by the worker provider and
// the server-side import classifier. No worker dependencies, so it survives
// worker retirement.
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { resolveOllamaChatUrl } from '../server/generation/providers/OllamaObservationProvider.js';

export interface OllamaConfig {
  apiKey: string;
  model: string;
  apiUrl: string;
}

export function getOllamaConfig(): OllamaConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Non-empty dummy key: the OpenAI-compat base class throws on falsy apiKey; Ollama ignores it.
  const apiKey = 'ollama-local';
  const model = (typeof settings.MEMSMITH_OLLAMA_MODEL === 'string' && settings.MEMSMITH_OLLAMA_MODEL.trim())
    ? settings.MEMSMITH_OLLAMA_MODEL : 'gemma4:12b';
  const base = settings.MEMSMITH_OLLAMA_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  return { apiKey, model, apiUrl: resolveOllamaChatUrl(base) };
}
