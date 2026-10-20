// SPDX-License-Identifier: Apache-2.0
//
// Resolve which generation provider to use at boot, in the same order as the
// rest of MemSmith's configuration: env > settings file > registry default. Env
// wins so a container or CI run can override without editing the user's
// settings file. The default is Claude with a local Ollama backup; installs that
// relied on the old Ollama default are pinned to it at boot
// (pin-legacy-generation-settings.ts), so the default only reaches new installs.

import { getSettingKey } from '../settings/settingKeys.js';

export const GENERATION_PROVIDERS = ['ollama', 'claude', 'gemini', 'openrouter'] as const;
export type GenerationProviderName = typeof GENERATION_PROVIDERS[number];

export const DEFAULT_GENERATION_PROVIDER: GenerationProviderName = 'claude';
export const DEFAULT_OLLAMA_MODEL = 'gemma4:12b';

export interface GenerationProviderSpec {
  provider: string;
  model?: string;
  fallback: string;
  fallbackModel: string;
  /** Set when env MEMSMITH_SERVER_PROVIDER or a team override chose the provider. */
  explicitProvider?: boolean;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Returns the provider to use, or null when an explicitly configured value is
 * not a known provider. Null (rather than a silent fallback) so the caller can
 * log the bad value and disable generation deliberately — a typo should be
 * visible, not quietly replaced with the default.
 */
export function resolveGenerationProviderName(
  env: Record<string, string | undefined> = process.env,
  settings: Record<string, unknown> = {},
): GenerationProviderName | null {
  const configured = clean(env.MEMSMITH_SERVER_PROVIDER) || clean(settings.MEMSMITH_SERVER_PROVIDER);
  if (!configured) return DEFAULT_GENERATION_PROVIDER;
  return (GENERATION_PROVIDERS as readonly string[]).includes(configured)
    ? (configured as GenerationProviderName)
    : null;
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** The resolved model when an operator set it; the registry default is a Claude model id, so it never counts. */
export function explicitModel(resolved: { value: unknown; source?: string } | null | undefined): string | undefined {
  return resolved && resolved.source !== 'default' ? firstNonEmpty(resolved.value) : undefined;
}

/**
 * The model Ollama generates with: an explicit model (team override, env
 * MEMSMITH_SERVER_MODEL, or the settings file), then MEMSMITH_OLLAMA_MODEL
 * (env, then settings file), then gemma4:12b.
 */
export function resolveOllamaModel(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown>,
  explicit?: string,
): string {
  return firstNonEmpty(
    explicit,
    env.MEMSMITH_SERVER_MODEL,
    settings.MEMSMITH_SERVER_MODEL,
    env.MEMSMITH_OLLAMA_MODEL,
    settings.MEMSMITH_OLLAMA_MODEL,
  ) ?? DEFAULT_OLLAMA_MODEL;
}

export function resolveBootGenerationSpec(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown>,
): GenerationProviderSpec | null {
  const provider = resolveGenerationProviderName(env, settings);
  if (!provider) return null;
  const model = provider === 'ollama'
    ? resolveOllamaModel(env, settings)
    : firstNonEmpty(env.MEMSMITH_SERVER_MODEL, settings.MEMSMITH_SERVER_MODEL);
  const fallbackSpec = getSettingKey('fallback')!;
  const configuredFallback = clean(env.MEMSMITH_SERVER_FALLBACK) || clean(settings.MEMSMITH_SERVER_FALLBACK);
  return {
    provider,
    ...(model ? { model } : {}),
    explicitProvider: Boolean(clean(env.MEMSMITH_SERVER_PROVIDER)),
    fallback: fallbackSpec.options!.includes(configuredFallback) ? configuredFallback : String(fallbackSpec.default),
    fallbackModel: firstNonEmpty(env.MEMSMITH_SERVER_FALLBACK_MODEL, settings.MEMSMITH_SERVER_FALLBACK_MODEL)
      ?? String(getSettingKey('fallbackModel')!.default),
  };
}
