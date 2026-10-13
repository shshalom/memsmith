// SPDX-License-Identifier: Apache-2.0
//
// Session-start check that the local generation provider can actually run.
//
// A fresh install generates with Ollama by default. Without Ollama running, or
// without the configured model pulled, every captured event fails generation and
// nothing is ever remembered while the session looks healthy; the server's
// health check only surfaces it as a stale backlog in the dashboard.

import { resolveGenerationProviderName } from '../../server/runtime/resolve-generation-provider.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434/v1';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:14b';
const PROBE_TIMEOUT_MS = 1500;

/** Provider and model as the server resolves them (env > dashboard > settings file > default). */
export interface ResolvedGenerationSettings {
  provider?: string;
  model?: string;
}

export interface GenerationReadinessDeps {
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  timeoutMs?: number;
}

function ollamaOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Ollama lists `qwen2.5:14b`; a configured name without a tag means `:latest`.
function hasModel(tags: unknown, model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  const models = (tags as { models?: Array<{ name?: unknown }> } | null)?.models;
  return Array.isArray(models) && models.some((m) => m?.name === wanted);
}

/**
 * Returns a user-facing message when generation cannot run, or null when it can
 * (or when the provider is not Ollama, whose readiness this does not probe).
 * `resolved` should come from the running server when available, so a provider
 * chosen in the dashboard wins over the settings file. Never throws.
 */
export async function checkGenerationReadiness(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
  deps: GenerationReadinessDeps = {},
  resolved: ResolvedGenerationSettings | null = null,
): Promise<string | null> {
  const provider = resolved?.provider ?? resolveGenerationProviderName(env, settings);
  if (provider !== 'ollama') return null;

  const configuredUrl = String(env.MEMSMITH_OLLAMA_URL || settings.MEMSMITH_OLLAMA_URL || DEFAULT_OLLAMA_URL);
  const model = String(resolved?.model || env.MEMSMITH_SERVER_MODEL || settings.MEMSMITH_SERVER_MODEL || DEFAULT_OLLAMA_MODEL);
  const origin = ollamaOrigin(configuredUrl);
  if (!origin) return null;

  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${origin}/api/tags`, { signal: controller.signal });
    if (!response.ok) return null;
    if (hasModel(await response.json(), model)) return null;
    return `MemSmith captures this session but cannot turn it into memories: the Ollama model ${model} is not installed. ` +
      `To fix it, run: ollama pull ${model}`;
  } catch {
    return `MemSmith captures this session but cannot turn it into memories: Ollama is not running at ${origin}. ` +
      `To fix it, install Ollama from https://ollama.com, start it, and run: ollama pull ${model}`;
  } finally {
    clearTimeout(timer);
  }
}
