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

export interface GenerationProviderSpec {
  provider: string;
  model?: string;
  fallback: string;
  fallbackModel: string;
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

export function resolveBootGenerationSpec(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown>,
): GenerationProviderSpec | null {
  const provider = resolveGenerationProviderName(env, settings);
  if (!provider) return null;
  const model = provider === 'ollama'
    ? firstNonEmpty(env.MEMSMITH_OLLAMA_MODEL, settings.MEMSMITH_SERVER_MODEL, settings.MEMSMITH_OLLAMA_MODEL)
    : firstNonEmpty(env.MEMSMITH_SERVER_MODEL, settings.MEMSMITH_SERVER_MODEL);
  const fallbackSpec = getSettingKey('fallback')!;
  const configuredFallback = clean(env.MEMSMITH_SERVER_FALLBACK) || clean(settings.MEMSMITH_SERVER_FALLBACK);
  return {
    provider,
    ...(model ? { model } : {}),
    fallback: fallbackSpec.options!.includes(configuredFallback) ? configuredFallback : String(fallbackSpec.default),
    fallbackModel: firstNonEmpty(env.MEMSMITH_SERVER_FALLBACK_MODEL, settings.MEMSMITH_SERVER_FALLBACK_MODEL)
      ?? String(getSettingKey('fallbackModel')!.default),
  };
}
