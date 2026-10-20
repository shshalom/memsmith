// SPDX-License-Identifier: Apache-2.0
//
// Installer wiring around the provider choice: what it starts from, what a
// cancelled key prompt leaves behind, and when the Ollama setup runs.
import { describe, it, expect } from 'bun:test';
import {
  chooseGenerationProvider,
  currentGenerationSelection,
  ollamaSetupMode,
  ollamaSetupPlan,
  shouldQueryRunningServer,
  type ProviderPromptIO,
} from '../../src/npx-cli/install/provider-prompt.js';
import { providerSettingsUpdates } from '../../src/npx-cli/install/generation-provider.js';

function io(overrides: Partial<ProviderPromptIO> = {}) {
  const saved: Array<Record<string, string>> = [];
  const warnings: string[] = [];
  const prompts: string[] = [];
  const base: ProviderPromptIO = {
    interactive: true,
    selectProvider: async (initial) => { prompts.push(`select:${initial}`); return initial; },
    anthropicKey: async () => { prompts.push('anthropic-key'); return true; },
    claudeModel: async () => { prompts.push('claude-model'); return 'claude-haiku-5-5'; },
    offerLocalBackup: async () => { prompts.push('local-backup'); return true; },
    hostedKey: async (provider) => { prompts.push(`key:${provider}`); return 'pasted'; },
    hasSavedKey: () => false,
    saveSettings: (updates) => { saved.push(updates); return true; },
    missingCredential: () => null,
    info: () => {},
    warn: (line) => warnings.push(line),
  };
  return { io: { ...base, ...overrides }, saved, warnings, prompts };
}

describe('currentGenerationSelection', () => {
  it('starts from the provider the dashboard set, which outranks the settings file', () => {
    const current = currentGenerationSelection(
      { MEMSMITH_SERVER_PROVIDER: 'ollama' },
      {},
      { provider: { value: 'claude', source: 'team' } },
      { MEMSMITH_SERVER_PROVIDER: 'ollama' },
    );
    expect(current.provider).toBe('claude');
    expect(current.dashboardOverride).toBe('claude');
  });

  it('falls back to env and settings file when the server is not reachable', () => {
    expect(currentGenerationSelection({ MEMSMITH_SERVER_PROVIDER: 'gemini' }, {}, null, { MEMSMITH_SERVER_PROVIDER: 'gemini' }).provider).toBe('gemini');
  });

  it('a reinstall keeps a custom Ollama model saved under either model key', () => {
    const ollamaKeySettings = { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' };
    const fromOllamaKey = currentGenerationSelection(ollamaKeySettings, {}, null, ollamaKeySettings);
    expect(fromOllamaKey.model).toBe('llama3.3:70b');
    expect(providerSettingsUpdates('ollama', { current: fromOllamaKey }).MEMSMITH_SERVER_MODEL).toBe('llama3.3:70b');
    const serverKeySettings = { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'mistral:7b', MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' };
    const fromServerKey = currentGenerationSelection(serverKeySettings, {}, null, serverKeySettings);
    expect(fromServerKey.model).toBe('mistral:7b');
  });
});

describe('an install that predates the provider setting', () => {
  const legacy = { MEMSMITH_RUNTIME: 'local', MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' };

  it('starts from Ollama with its pinned model, so a flag-less reinstall never moves it to Claude', async () => {
    const current = currentGenerationSelection(legacy, {}, null, legacy);
    expect(current).toMatchObject({ provider: 'ollama', model: 'llama3.3:70b' });
    const h = io({ interactive: false });
    expect(await chooseGenerationProvider({}, current, h.io)).toEqual({ provider: 'ollama', confirmed: true, localBackup: false });
    expect(h.saved).toEqual([]);
  });

  it('an install that ran Ollama under the old provider key stays on Ollama and its model', () => {
    const old = { MEMSMITH_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b' };
    const current = currentGenerationSelection({ ...old, MEMSMITH_RUNTIME: 'local' }, {}, null, old);
    expect(current).toMatchObject({ provider: 'ollama', model: 'qwen2.5:14b' });
    expect(current.recordProvider).toBeUndefined();
  });
});

describe('a fresh install', () => {
  // promptRuntime has already written MEMSMITH_RUNTIME when the provider step runs.
  const afterRuntimePrompt = { MEMSMITH_RUNTIME: 'local' };

  it('starts from Claude even though this run already wrote MEMSMITH_RUNTIME', () => {
    expect(currentGenerationSelection(afterRuntimePrompt, {}, null, {})).toMatchObject({ provider: 'claude', recordProvider: true });
  });

  it('a non-interactive run records MEMSMITH_SERVER_PROVIDER=claude so the next boot does not pin Ollama', async () => {
    const h = io({ interactive: false });
    const outcome = await chooseGenerationProvider({}, currentGenerationSelection(afterRuntimePrompt, {}, null, {}), h.io);
    expect(outcome.provider).toBe('claude');
    expect(h.saved).toEqual([{ MEMSMITH_SERVER_PROVIDER: 'claude' }]);
  });

  it('a cancelled key prompt still records the default provider', async () => {
    const h = io({ anthropicKey: async () => false });
    await chooseGenerationProvider({}, currentGenerationSelection(afterRuntimePrompt, {}, null, {}), h.io);
    expect(h.saved).toEqual([{ MEMSMITH_SERVER_PROVIDER: 'claude' }]);
  });

  it('a reinstall that already names a provider writes nothing when nothing is chosen', async () => {
    const saved = { MEMSMITH_RUNTIME: 'local', MEMSMITH_SERVER_PROVIDER: 'gemini' };
    const h = io({ interactive: false });
    await chooseGenerationProvider({}, currentGenerationSelection(saved, {}, null, saved), h.io);
    expect(h.saved).toEqual([]);
  });
});

describe('chooseGenerationProvider', () => {
  const ollamaCurrent = { provider: 'ollama' as const };

  it('cancelling the Gemini key prompt keeps the current provider and saves nothing', async () => {
    const h = io({ selectProvider: async () => 'gemini', hostedKey: async () => null });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'ollama', confirmed: false, localBackup: false });
    expect(h.saved).toEqual([]);
  });

  it('cancelling the Anthropic key prompt keeps the current provider and saves nothing', async () => {
    const h = io({ selectProvider: async () => 'claude', anthropicKey: async () => false });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'ollama', confirmed: false, localBackup: false });
    expect(h.saved).toEqual([]);
  });

  it('choosing Claude with a key saves MEMSMITH_SERVER_PROVIDER=claude', async () => {
    const h = io({ selectProvider: async () => 'claude' });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'claude', confirmed: true, localBackup: true });
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'claude', MEMSMITH_SERVER_MODEL: 'claude-haiku-5-5' });
  });

  it('claude choice asks for the local backup and plans a gemma4:12b pull on yes', async () => {
    const h = io({ selectProvider: async () => 'claude' });
    const outcome = await chooseGenerationProvider({}, ollamaCurrent, h.io);
    expect(h.prompts).toEqual(['anthropic-key', 'claude-model', 'local-backup']);
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'claude', MEMSMITH_SERVER_FALLBACK: 'ollama' });
    expect(ollamaSetupPlan(outcome, 'local', false)).toEqual({ run: true, model: 'gemma4:12b' });
  });

  it('declining the backup saves fallback none and plans no pull', async () => {
    const h = io({ selectProvider: async () => 'claude', offerLocalBackup: async () => false });
    const outcome = await chooseGenerationProvider({}, ollamaCurrent, h.io);
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'claude', MEMSMITH_SERVER_FALLBACK: 'none' });
    expect(outcome.localBackup).toBe(false);
    expect(ollamaSetupPlan(outcome, 'local', false)).toEqual({ run: false });
  });

  it('non-interactive claude install does not prompt and keeps the backup off unless --local-backup is passed', async () => {
    const off = io({ interactive: false });
    const offOutcome = await chooseGenerationProvider({ provider: 'claude' }, ollamaCurrent, off.io);
    expect(off.prompts).toEqual([]);
    expect(off.saved[0]).toMatchObject({ MEMSMITH_SERVER_FALLBACK: 'none' });
    expect(offOutcome.localBackup).toBe(false);

    const on = io({ interactive: false });
    const onOutcome = await chooseGenerationProvider({ provider: 'claude', localBackup: true }, ollamaCurrent, on.io);
    expect(on.prompts).toEqual([]);
    expect(on.saved[0]).toMatchObject({ MEMSMITH_SERVER_FALLBACK: 'ollama' });
    expect(ollamaSetupPlan(onOutcome, 'local', false)).toEqual({ run: true, model: 'gemma4:12b' });
  });

  it('--provider in a terminal skips the menu but still asks for the key', async () => {
    const h = io();
    await chooseGenerationProvider({ provider: 'openrouter' }, ollamaCurrent, h.io);
    expect(h.prompts).toEqual(['key:openrouter']);
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'openrouter', MEMSMITH_OPENROUTER_API_KEY: 'pasted' });
  });

  it('a non-interactive --provider writes the provider and warns about a missing key', async () => {
    const h = io({ interactive: false, missingCredential: () => 'MEMSMITH_GEMINI_API_KEY in ~/.memsmith/settings.json' });
    expect(await chooseGenerationProvider({ provider: 'gemini' }, ollamaCurrent, h.io)).toEqual({ provider: 'gemini', confirmed: true, localBackup: false });
    expect(h.prompts).toEqual([]);
    expect(h.saved[0].MEMSMITH_SERVER_PROVIDER).toBe('gemini');
    expect(h.warnings.join('\n')).toContain('MEMSMITH_GEMINI_API_KEY');
  });

  it('warns when a dashboard override will keep winning over the choice', async () => {
    const h = io({ selectProvider: async () => 'ollama' });
    await chooseGenerationProvider({}, { provider: 'claude', dashboardOverride: 'claude' }, h.io);
    expect(h.warnings.join('\n')).toContain('dashboard');
  });
});

describe('ollamaSetupMode', () => {
  it('asks in a terminal when the user picked from the menu', () => {
    expect(ollamaSetupMode({ interactive: true })).toBe('interactive');
  });

  it('a confirmed local backup installs without asking again, even with --provider claude', () => {
    expect(ollamaSetupMode({ interactive: true, provider: 'claude', localBackup: true })).toBe('opt-in');
    expect(ollamaSetupMode({ interactive: true, provider: 'claude', localBackup: false })).toBe('non-interactive');
  });

  it('treats --provider in a terminal as non-interactive', () => {
    expect(ollamaSetupMode({ interactive: true, provider: 'ollama' })).toBe('non-interactive');
  });

  it('never asks without a terminal', () => {
    expect(ollamaSetupMode({ interactive: false })).toBe('non-interactive');
  });

  it('--setup-ollama opts in regardless', () => {
    expect(ollamaSetupMode({ interactive: false, provider: 'ollama', setupOllama: true })).toBe('opt-in');
  });
});

describe('ollamaSetupPlan', () => {
  it('runs for a chosen Ollama on the local runtime', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true, localBackup: false }, 'local', false)).toEqual({ run: true });
  });

  it('verifies the model an older install is pinned to, not the new default', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true, localBackup: false }, 'local', false, 'qwen2.5:14b'))
      .toEqual({ run: true, model: 'qwen2.5:14b' });
  });

  it('skips the server runtime, which generates on the team server', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true, localBackup: false }, 'server', false)).toEqual({ run: false });
  });

  it('skips when a cancelled key prompt left Ollama in place', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: false, localBackup: false }, 'local', false)).toEqual({ run: false });
  });

  it('says --setup-ollama was ignored when it cannot apply', () => {
    expect(ollamaSetupPlan({ provider: 'claude', confirmed: true, localBackup: false }, 'local', true).ignored).toContain('--setup-ollama');
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true, localBackup: false }, 'server', true).ignored).toContain('server runtime');
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true, localBackup: false }, 'local', true).ignored).toBeUndefined();
  });
});

// The dashboard lookup sends GET /v1/settings. It must not reach a remote team
// server the user is leaving, or ask a server this run is replacing.
describe('shouldQueryRunningServer', () => {
  const local = 'http://127.0.0.1:38877';

  it('asks the local server when the runtime stays the same', () => {
    expect(shouldQueryRunningServer({ chosenRuntime: 'local', existingRuntime: 'local', existingServerUrl: local })).toBe(true);
    expect(shouldQueryRunningServer({ chosenRuntime: 'local', existingRuntime: undefined, existingServerUrl: local })).toBe(true);
    expect(shouldQueryRunningServer({ chosenRuntime: 'local', existingRuntime: 'worker', existingServerUrl: 'http://localhost:38877' })).toBe(true);
  });

  it('never asks a remote team server', () => {
    expect(shouldQueryRunningServer({ chosenRuntime: 'server', existingRuntime: 'server', existingServerUrl: 'https://memsmith.team.example.com' })).toBe(false);
  });

  it('does not ask when this run switches runtime', () => {
    expect(shouldQueryRunningServer({ chosenRuntime: 'local', existingRuntime: 'server', existingServerUrl: local })).toBe(false);
    expect(shouldQueryRunningServer({ chosenRuntime: 'server', existingRuntime: 'local', existingServerUrl: local })).toBe(false);
  });

  it('does not ask when the saved URL is unusable', () => {
    expect(shouldQueryRunningServer({ chosenRuntime: 'local', existingRuntime: 'local', existingServerUrl: 'not a url' })).toBe(false);
  });
});
