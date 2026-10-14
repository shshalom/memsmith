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

/** Provider and model as the server resolves them (dashboard > env > settings file > default). */
export interface ResolvedGenerationSettings {
  provider?: string;
  model?: string;
}

export interface GenerationReadinessDeps {
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  timeoutMs?: number;
}

export interface OllamaTarget {
  origin: string;
  model: string;
  /** False when the configured Ollama runs on another machine. */
  local: boolean;
}

export type OllamaProbeResult = 'ready' | 'model-missing' | 'unreachable' | 'unknown';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

// Ollama lists `qwen2.5:14b`; a configured name without a tag means `:latest`.
function hasModel(tags: unknown, model: string): boolean {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  const models = (tags as { models?: Array<{ name?: unknown }> } | null)?.models;
  return Array.isArray(models) && models.some((m) => m?.name === wanted);
}

/** The Ollama origin and model generation uses (env > settings file > default), or null for an unparseable URL. */
export function resolveOllamaTarget(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
  resolved: ResolvedGenerationSettings | null = null,
): OllamaTarget | null {
  const configuredUrl = String(env.MEMSMITH_OLLAMA_URL || settings.MEMSMITH_OLLAMA_URL || DEFAULT_OLLAMA_URL);
  const model = String(resolved?.model || env.MEMSMITH_SERVER_MODEL || settings.MEMSMITH_SERVER_MODEL || DEFAULT_OLLAMA_MODEL);
  try {
    const url = new URL(configuredUrl);
    return { origin: url.origin, model, local: LOOPBACK_HOSTS.has(url.hostname) };
  } catch {
    return null;
  }
}

/** Never throws. `unknown` means something answered but not like Ollama. */
export async function probeOllama(target: OllamaTarget, deps: GenerationReadinessDeps = {}): Promise<OllamaProbeResult> {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const response = await doFetch(`${target.origin}/api/tags`, { signal: controller.signal });
    if (!response.ok) return 'unknown';
    return hasModel(await response.json(), target.model) ? 'ready' : 'model-missing';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
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

  const target = resolveOllamaTarget(settings, env, resolved);
  if (!target) return null;
  const { origin, model } = target;
  const result = await probeOllama(target, deps);
  if (result === 'model-missing') {
    return `MemSmith captures this session but cannot turn it into memories: the Ollama model ${model} is not installed. ` +
      `To fix it, run: ollama pull ${model}`;
  }
  if (result === 'unreachable') {
    return `MemSmith captures this session but cannot turn it into memories: Ollama is not running at ${origin}. ` +
      `To fix it, install Ollama from https://ollama.com, start it, and run: ollama pull ${model}`;
  }
  return null;
}
