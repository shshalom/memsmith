// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_GENERATION_PROVIDER,
  DEFAULT_OLLAMA_MODEL,
  resolveGenerationProviderName,
  type GenerationProviderName,
} from '../../server/runtime/resolve-generation-provider.js';
import { DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from '../../server/generation/providers/GeminiObservationProvider.js';
import { DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL } from '../../server/generation/providers/OpenRouterObservationProvider.js';

export { DEFAULT_OLLAMA_MODEL };
export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';

export const GENERATION_PROVIDER_CHOICES: ReadonlyArray<{ value: GenerationProviderName; label: string; hint: string }> = [
  { value: 'claude', label: 'Claude Haiku 5.5 (recommended)', hint: 'needs an Anthropic API key; about $1 per 1,000 observations' },
  { value: 'ollama', label: 'Ollama — local and private, no API key', hint: 'runs on this machine; downloads an 8 GB model' },
  { value: 'gemini', label: 'Gemini', hint: 'needs a Google AI Studio API key' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'needs an OpenRouter API key; many hosted models' },
];

const DEFAULT_MODEL: Record<GenerationProviderName, string> = {
  ollama: DEFAULT_OLLAMA_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
  gemini: GEMINI_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
};

const API_KEY_SETTING: Partial<Record<GenerationProviderName, string>> = {
  gemini: 'MEMSMITH_GEMINI_API_KEY',
  openrouter: 'MEMSMITH_OPENROUTER_API_KEY',
};

export function apiKeySettingFor(provider: GenerationProviderName): string | undefined {
  return API_KEY_SETTING[provider];
}

/** The provider generation uses today; the legacy MEMSMITH_PROVIDER key is deliberately ignored. */
export function initialGenerationProvider(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined>,
): GenerationProviderName {
  return resolveGenerationProviderName(env, settings) ?? DEFAULT_GENERATION_PROVIDER;
}

export interface ProviderSettingsOptions {
  model?: string;
  /** Gemini or OpenRouter key; the Anthropic key lives in ~/.memsmith/.env instead. */
  apiKey?: string;
  current?: { provider?: string; model?: string };
  /** Whether a failed Claude call falls back to the local Ollama model. */
  fallback?: 'ollama' | 'none';
}

/** The settings.json entries that make generation use `provider`. */
export function providerSettingsUpdates(
  provider: GenerationProviderName,
  opts: ProviderSettingsOptions,
): Record<string, string> {
  const keepCurrentModel = opts.current?.provider === provider && opts.current.model?.trim();
  const model = opts.model?.trim() || (keepCurrentModel ? opts.current!.model!.trim() : DEFAULT_MODEL[provider]);
  const updates: Record<string, string> = {
    MEMSMITH_SERVER_PROVIDER: provider,
    MEMSMITH_SERVER_MODEL: model,
  };
  // The boot-time provider reads the Ollama model from its own key first.
  if (provider === 'ollama') updates.MEMSMITH_OLLAMA_MODEL = model;
  if (opts.fallback) updates.MEMSMITH_SERVER_FALLBACK = opts.fallback;
  const keySetting = API_KEY_SETTING[provider];
  if (keySetting && opts.apiKey?.trim()) updates[keySetting] = opts.apiKey.trim();
  return updates;
}
