// SPDX-License-Identifier: Apache-2.0
//
// The installer's provider decision, with prompts injected so the wiring is
// testable without a terminal.

import {
  GENERATION_PROVIDERS,
  type GenerationProviderName,
} from '../../server/runtime/resolve-generation-provider.js';
import {
  DEFAULT_OLLAMA_MODEL,
  initialGenerationProvider,
  providerSettingsUpdates,
} from './generation-provider.js';
import { legacyGenerationPins } from '../../server/settings/pin-legacy-generation-settings.js';
import type { OllamaSetupMode } from './ollama-setup.js';
import { normalizeRuntimeFlag } from '../commands/server-runtime-setup.js';
import { resolveServerAddress } from '../commands/lifecycle.js';

/** The shape of `GET /v1/settings` entries that matter here. */
export type ResolvedSettingsSnapshot = Partial<Record<'provider' | 'model', { value: unknown; source?: string }>>;

export interface CurrentGeneration {
  provider: GenerationProviderName;
  model?: string;
  /** Set when a dashboard override decides the provider, which outranks settings.json. */
  dashboardOverride?: GenerationProviderName;
  /**
   * The settings file named no provider before this run and is not a legacy
   * install, so the provider must be written even when nothing is chosen;
   * otherwise the next server boot pins the file to Ollama.
   */
  recordProvider?: boolean;
}

function asProvider(value: unknown): GenerationProviderName | undefined {
  return typeof value === 'string' && (GENERATION_PROVIDERS as readonly string[]).includes(value)
    ? (value as GenerationProviderName)
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * `resolved` comes from the running server when it is reachable; null falls
 * back to env and settings.json. Legacy detection reads `settingsBeforeInstall`
 * because this run has already written MEMSMITH_RUNTIME, which would make an
 * empty machine look like an old install.
 */
export function currentGenerationSelection(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined>,
  resolved: ResolvedSettingsSnapshot | null,
  settingsBeforeInstall: Record<string, unknown>,
): CurrentGeneration {
  const resolvedProvider = asProvider(resolved?.provider?.value);
  const pins = legacyGenerationPins(settingsBeforeInstall, env);
  const provider = resolvedProvider ?? (pins ? 'ollama' : initialGenerationProvider(settings, env));
  const resolvedModel = resolved?.model && resolved.model.source !== 'default' ? nonBlank(resolved.model.value) : undefined;
  const savedModel = nonBlank(settings.MEMSMITH_SERVER_MODEL)
    ?? (provider === 'ollama' ? nonBlank(settings.MEMSMITH_OLLAMA_MODEL) : undefined)
    ?? (pins && provider === 'ollama' ? pins.MEMSMITH_SERVER_MODEL : undefined);
  const current: CurrentGeneration = { provider, model: resolvedModel ?? savedModel };
  if (resolvedProvider && resolved?.provider?.source === 'team') current.dashboardOverride = resolvedProvider;
  if (!pins && !nonBlank(settingsBeforeInstall.MEMSMITH_SERVER_PROVIDER)) current.recordProvider = true;
  return current;
}

export interface ProviderPromptIO {
  interactive: boolean;
  selectProvider(initial: GenerationProviderName): Promise<GenerationProviderName>;
  /** False when the user cancels; true when a key is kept or entered. */
  anthropicKey(): Promise<boolean>;
  claudeModel(current: string | undefined): Promise<string>;
  /** Whether to install the local Ollama model that takes over when Claude is unavailable. */
  offerLocalBackup(): Promise<boolean>;
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
  localBackup: boolean;
}

export async function chooseGenerationProvider(
  options: { provider?: GenerationProviderName; model?: string; localBackup?: boolean },
  current: CurrentGeneration,
  io: ProviderPromptIO,
): Promise<ProviderOutcome> {
  const save = (provider: GenerationProviderName, extra: { model?: string; apiKey?: string; fallback?: 'ollama' | 'none' } = {}): void => {
    const updates = providerSettingsUpdates(provider, { model: extra.model ?? options.model, apiKey: extra.apiKey, fallback: extra.fallback, current });
    if (io.saveSettings(updates)) {
      io.info(`Saved generation provider=${provider} (model ${updates.MEMSMITH_SERVER_MODEL}) to ~/.memsmith/settings.json`);
    }
    if (current.dashboardOverride && current.dashboardOverride !== provider) {
      io.warn(`The dashboard Settings tab sets the generation provider to ${current.dashboardOverride}, which overrides this choice. To use ${provider}, change it there.`);
    }
  };
  const recordCurrent = (): void => {
    if (current.recordProvider) io.saveSettings({ MEMSMITH_SERVER_PROVIDER: current.provider });
  };
  const cancelled = (): ProviderOutcome => {
    io.warn(`API key prompt cancelled — generation provider stays ${current.provider}.`);
    recordCurrent();
    return { provider: current.provider, confirmed: false, localBackup: false };
  };

  if (!io.interactive) {
    if (!options.provider) {
      recordCurrent();
      return { provider: current.provider, confirmed: true, localBackup: false };
    }
    const localBackup = options.provider === 'claude' && options.localBackup === true;
    save(options.provider, options.provider === 'claude' ? { fallback: localBackup ? 'ollama' : 'none' } : {});
    const missing = io.missingCredential(options.provider);
    if (missing) io.warn(`Generation provider ${options.provider} needs an API key before it can create memories. Set ${missing}.`);
    return { provider: options.provider, confirmed: true, localBackup };
  }

  const provider = options.provider ?? await io.selectProvider(current.provider);

  if (provider === 'ollama') {
    save('ollama');
    return { provider, confirmed: true, localBackup: false };
  }

  if (provider === 'claude') {
    if (!(await io.anthropicKey())) return cancelled();
    const model = options.model ?? await io.claudeModel(current.provider === 'claude' ? current.model : undefined);
    const localBackup = options.localBackup ?? await io.offerLocalBackup();
    save('claude', { model, fallback: localBackup ? 'ollama' : 'none' });
    return { provider, confirmed: true, localBackup };
  }

  if (io.hasSavedKey(provider)) {
    save(provider);
    return { provider, confirmed: true, localBackup: false };
  }
  const apiKey = await io.hostedKey(provider);
  if (apiKey === null) return cancelled();
  save(provider, { apiKey });
  return { provider, confirmed: true, localBackup: false };
}

/**
 * Whether the dashboard lookup may ask the running server. Not a remote team
 * server (doctor leaves those alone too), and not when this run switches
 * runtime, because that server's settings no longer apply. Pass the settings
 * as they were before this run changed them.
 */
export function shouldQueryRunningServer(o: {
  chosenRuntime: 'local' | 'server';
  existingRuntime: unknown;
  existingServerUrl: string;
}): boolean {
  const existing = normalizeRuntimeFlag(typeof o.existingRuntime === 'string' ? o.existingRuntime : undefined);
  if (existing !== o.chosenRuntime) return false;
  try {
    return !resolveServerAddress(o.existingServerUrl).remote;
  } catch {
    return false;
  }
}

export function ollamaSetupMode(o: { interactive: boolean; provider?: string; setupOllama?: boolean; localBackup?: boolean }): OllamaSetupMode {
  if (o.setupOllama || o.localBackup) return 'opt-in';
  return o.interactive && !o.provider ? 'interactive' : 'non-interactive';
}

export function ollamaSetupPlan(
  outcome: ProviderOutcome,
  runtime: 'local' | 'server',
  setupOllamaFlag: boolean,
  /** The model an older install's server is pinned to, which the readiness check must verify. */
  pinnedModel?: string,
): { run: boolean; model?: string; ignored?: string } {
  if (runtime === 'local' && outcome.provider === 'claude' && outcome.confirmed && outcome.localBackup) {
    return { run: true, model: DEFAULT_OLLAMA_MODEL };
  }
  if (outcome.provider === 'ollama' && outcome.confirmed && runtime === 'local') {
    return pinnedModel ? { run: true, model: pinnedModel } : { run: true };
  }
  if (!setupOllamaFlag) return { run: false };
  if (runtime === 'server') return { run: false, ignored: '--setup-ollama ignored: the server runtime generates on the team server.' };
  if (outcome.provider !== 'ollama') return { run: false, ignored: `--setup-ollama ignored: the generation provider is ${outcome.provider}, not ollama.` };
  return { run: false, ignored: '--setup-ollama ignored: no generation provider was chosen.' };
}
