// SPDX-License-Identifier: Apache-2.0
//
// The installer saves Gemini and OpenRouter keys to ~/.memsmith/settings.json and
// the Anthropic key to ~/.memsmith/.env. The server process is not launched with
// either file exported into its environment, so credentials resolve here. Each
// key follows MemSmith env var > saved file > generic shell var: a generic var
// such as ANTHROPIC_API_KEY can arrive from an unrelated project's .env (#733),
// so it never outranks what the user saved for MemSmith.

import { loadMemSmithEnv } from '../../shared/EnvManager.js';
import { readFlatSettings } from '../../shared/flat-settings.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export interface GenerationConfigSources {
  env: Record<string, string | undefined>;
  settings: Record<string, unknown>;
  dotEnv: Record<string, string | undefined>;
}

export interface GenerationCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export function loadGenerationConfigSources(): GenerationConfigSources {
  let settings: Record<string, unknown> = {};
  try {
    settings = readFlatSettings(USER_SETTINGS_PATH) ?? {};
  } catch { /* unreadable settings: env and .env still apply */ }
  let dotEnv: Record<string, string | undefined> = {};
  try {
    dotEnv = { ...loadMemSmithEnv() };
  } catch { /* no .env */ }
  return { env: process.env, settings, dotEnv };
}

function firstNonBlank(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveGenerationCredentials(provider: string, s: GenerationConfigSources): GenerationCredentials {
  const { env, settings, dotEnv } = s;
  switch (provider) {
    case 'claude':
    case 'anthropic':
      return { apiKey: firstNonBlank(env.MEMSMITH_ANTHROPIC_API_KEY, dotEnv.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY) };
    case 'gemini':
      return { apiKey: firstNonBlank(env.MEMSMITH_GEMINI_API_KEY, settings.MEMSMITH_GEMINI_API_KEY, env.GEMINI_API_KEY) };
    case 'openrouter':
      return {
        apiKey: firstNonBlank(env.MEMSMITH_OPENROUTER_API_KEY, settings.MEMSMITH_OPENROUTER_API_KEY, env.OPENROUTER_API_KEY),
        baseUrl: firstNonBlank(env.MEMSMITH_OPENROUTER_BASE_URL, settings.MEMSMITH_OPENROUTER_BASE_URL, env.OPENROUTER_BASE_URL),
      };
    case 'ollama':
      return {
        apiKey: firstNonBlank(env.MEMSMITH_OLLAMA_API_KEY, settings.MEMSMITH_OLLAMA_API_KEY),
        baseUrl: firstNonBlank(env.MEMSMITH_OLLAMA_URL, settings.MEMSMITH_OLLAMA_URL),
      };
    default:
      return {};
  }
}

const REQUIRED_KEY: Record<string, string> = {
  claude: 'ANTHROPIC_API_KEY in ~/.memsmith/.env',
  gemini: 'MEMSMITH_GEMINI_API_KEY in ~/.memsmith/settings.json',
  openrouter: 'MEMSMITH_OPENROUTER_API_KEY in ~/.memsmith/settings.json',
};

/** Where the missing API key belongs, or null when the provider can authenticate. */
export function missingGenerationCredential(provider: string, s: GenerationConfigSources): string | null {
  const required = REQUIRED_KEY[provider];
  if (!required) return null;
  return resolveGenerationCredentials(provider, s).apiKey ? null : required;
}
