// SPDX-License-Identifier: Apache-2.0
//
// Resolve which generation provider to use at boot.
//
// The setting registry (settingKeys.ts) declares the provider's default as
// 'ollama' — a local model, no API key, which is exactly right for a local
// install. But the boot path read only process.env.MEMSMITH_SERVER_PROVIDER and
// returned null when it was empty. MemSmith's settings live in
// ~/.memsmith/settings.json, not the process environment, so on a fresh install
// the declared default never applied: generation was disabled, and every
// observation-generation job queued forever.
//
// Resolution order is env > settings file > registry default, matching how the
// rest of MemSmith resolves configuration (env wins so a container or CI run can
// override without editing the user's settings file).

export const GENERATION_PROVIDERS = ['ollama', 'claude', 'gemini', 'openrouter'] as const;
export type GenerationProviderName = typeof GENERATION_PROVIDERS[number];

// Mirrors SETTING_KEYS' `provider` default. Local-first: runs on the user's
// machine, needs no API key, so a fresh install generates memory out of the box.
export const DEFAULT_GENERATION_PROVIDER: GenerationProviderName = 'ollama';

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
