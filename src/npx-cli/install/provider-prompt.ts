// SPDX-License-Identifier: Apache-2.0
//
// The installer's provider decision, with prompts injected so the wiring is
// testable without a terminal.

import {
  GENERATION_PROVIDERS,
  type GenerationProviderName,
} from '../../server/runtime/resolve-generation-provider.js';
import {
  initialGenerationProvider,
  providerSettingsUpdates,
} from './generation-provider.js';
import type { OllamaSetupMode } from './ollama-setup.js';

/** The shape of `GET /v1/settings` entries that matter here. */
export type ResolvedSettingsSnapshot = Partial<Record<'provider' | 'model', { value: unknown; source?: string }>>;

export interface CurrentGeneration {
  provider: GenerationProviderName;
  model?: string;
  /** Set when a dashboard override decides the provider, which outranks settings.json. */
  dashboardOverride?: GenerationProviderName;
}

function asProvider(value: unknown): GenerationProviderName | undefined {
  return typeof value === 'string' && (GENERATION_PROVIDERS as readonly string[]).includes(value)
    ? (value as GenerationProviderName)
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `resolved` comes from the running server when it is reachable; null falls back to env and settings.json. */
export function currentGenerationSelection(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined>,
  resolved: ResolvedSettingsSnapshot | null,
): CurrentGeneration {
  const resolvedProvider = asProvider(resolved?.provider?.value);
  const provider = resolvedProvider ?? initialGenerationProvider(settings, env);
  const resolvedModel = resolved?.model && resolved.model.source !== 'default' ? nonBlank(resolved.model.value) : undefined;
  const savedModel = nonBlank(settings.MEMSMITH_SERVER_MODEL)
    ?? (provider === 'ollama' ? nonBlank(settings.MEMSMITH_OLLAMA_MODEL) : undefined);
  const current: CurrentGeneration = { provider, model: resolvedModel ?? savedModel };
  if (resolvedProvider && resolved?.provider?.source === 'team') current.dashboardOverride = resolvedProvider;
  return current;
}

export interface ProviderPromptIO {
  interactive: boolean;
  selectProvider(initial: GenerationProviderName): Promise<GenerationProviderName>;
  /** False when the user cancels; true when a key is kept or entered. */
  anthropicKey(): Promise<boolean>;
  claudeModel(current: string | undefined): Promise<string>;
  /** The pasted key, or null when the user cancels. */
  hostedKey(provider: 'gemini' | 'openrouter'): Promise<string | null>;
  hasSavedKey(provider: GenerationProviderName): boolean;
  saveSettings(updates: Record<string, string>): boolean;
  missingCredential(provider: GenerationProviderName): string | null;
  info(line: string): void;
  warn(line: string): void;
}

/** `confirmed` is false when a cancelled key prompt left the earlier provider in place. */
export interface ProviderOutcome {
  provider: GenerationProviderName;
  confirmed: boolean;
}

export async function chooseGenerationProvider(
  options: { provider?: GenerationProviderName; model?: string },
  current: CurrentGeneration,
  io: ProviderPromptIO,
): Promise<ProviderOutcome> {
  const save = (provider: GenerationProviderName, extra: { model?: string; apiKey?: string } = {}): void => {
    const updates = providerSettingsUpdates(provider, { model: extra.model ?? options.model, apiKey: extra.apiKey, current });
    if (io.saveSettings(updates)) {
      io.info(`Saved generation provider=${provider} (model ${updates.MEMSMITH_SERVER_MODEL}) to ~/.memsmith/settings.json`);
    }
    if (current.dashboardOverride && current.dashboardOverride !== provider) {
      io.warn(`The dashboard Settings tab sets the generation provider to ${current.dashboardOverride}, which overrides this choice. To use ${provider}, change it there.`);
    }
  };
  const cancelled = (): ProviderOutcome => {
    io.warn(`API key prompt cancelled — generation provider stays ${current.provider}.`);
    return { provider: current.provider, confirmed: false };
  };

  if (!io.interactive) {
    if (!options.provider) return { provider: current.provider, confirmed: true };
    save(options.provider);
    const missing = io.missingCredential(options.provider);
    if (missing) io.warn(`Generation provider ${options.provider} needs an API key before it can create memories. Set ${missing}.`);
    return { provider: options.provider, confirmed: true };
  }

  const provider = options.provider ?? await io.selectProvider(current.provider);

  if (provider === 'ollama') {
    save('ollama');
    return { provider, confirmed: true };
  }

  if (provider === 'claude') {
    if (!(await io.anthropicKey())) return cancelled();
    const model = options.model ?? await io.claudeModel(current.provider === 'claude' ? current.model : undefined);
    save('claude', { model });
    return { provider, confirmed: true };
  }

  if (io.hasSavedKey(provider)) {
    save(provider);
    return { provider, confirmed: true };
  }
  const apiKey = await io.hostedKey(provider);
  if (apiKey === null) return cancelled();
  save(provider, { apiKey });
  return { provider, confirmed: true };
}

export function ollamaSetupMode(o: { interactive: boolean; provider?: string; setupOllama?: boolean }): OllamaSetupMode {
  if (o.setupOllama) return 'opt-in';
  return o.interactive && !o.provider ? 'interactive' : 'non-interactive';
}

export function ollamaSetupPlan(
  outcome: ProviderOutcome,
  runtime: 'local' | 'server',
  setupOllamaFlag: boolean,
): { run: boolean; ignored?: string } {
  if (outcome.provider === 'ollama' && outcome.confirmed && runtime === 'local') return { run: true };
  if (!setupOllamaFlag) return { run: false };
  if (runtime === 'server') return { run: false, ignored: '--setup-ollama ignored: the server runtime generates on the team server.' };
  if (outcome.provider !== 'ollama') return { run: false, ignored: `--setup-ollama ignored: the generation provider is ${outcome.provider}, not ollama.` };
  return { run: false, ignored: '--setup-ollama ignored: no generation provider was chosen.' };
}
