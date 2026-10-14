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
    claudeModel: async () => { prompts.push('claude-model'); return 'claude-haiku-4-5-20251001'; },
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
    );
    expect(current.provider).toBe('claude');
    expect(current.dashboardOverride).toBe('claude');
  });

  it('falls back to env and settings file when the server is not reachable', () => {
    expect(currentGenerationSelection({ MEMSMITH_SERVER_PROVIDER: 'gemini' }, {}, null).provider).toBe('gemini');
  });

  it('a reinstall keeps a custom Ollama model saved under either model key', () => {
    const fromOllamaKey = currentGenerationSelection({ MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' }, {}, null);
    expect(fromOllamaKey.model).toBe('llama3.3:70b');
    expect(providerSettingsUpdates('ollama', { current: fromOllamaKey }).MEMSMITH_SERVER_MODEL).toBe('llama3.3:70b');
    const fromServerKey = currentGenerationSelection({ MEMSMITH_SERVER_MODEL: 'mistral:7b', MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' }, {}, null);
    expect(fromServerKey.model).toBe('mistral:7b');
  });
});

describe('chooseGenerationProvider', () => {
  const ollamaCurrent = { provider: 'ollama' as const };

  it('cancelling the Gemini key prompt keeps the current provider and saves nothing', async () => {
    const h = io({ selectProvider: async () => 'gemini', hostedKey: async () => null });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'ollama', confirmed: false });
    expect(h.saved).toEqual([]);
  });

  it('cancelling the Anthropic key prompt keeps the current provider and saves nothing', async () => {
    const h = io({ selectProvider: async () => 'claude', anthropicKey: async () => false });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'ollama', confirmed: false });
    expect(h.saved).toEqual([]);
  });

  it('choosing Claude with a key saves MEMSMITH_SERVER_PROVIDER=claude', async () => {
    const h = io({ selectProvider: async () => 'claude' });
    expect(await chooseGenerationProvider({}, ollamaCurrent, h.io)).toEqual({ provider: 'claude', confirmed: true });
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'claude', MEMSMITH_SERVER_MODEL: 'claude-haiku-4-5-20251001' });
  });

  it('--provider in a terminal skips the menu but still asks for the key', async () => {
    const h = io();
    await chooseGenerationProvider({ provider: 'openrouter' }, ollamaCurrent, h.io);
    expect(h.prompts).toEqual(['key:openrouter']);
    expect(h.saved[0]).toMatchObject({ MEMSMITH_SERVER_PROVIDER: 'openrouter', MEMSMITH_OPENROUTER_API_KEY: 'pasted' });
  });

  it('a non-interactive --provider writes the provider and warns about a missing key', async () => {
    const h = io({ interactive: false, missingCredential: () => 'MEMSMITH_GEMINI_API_KEY in ~/.memsmith/settings.json' });
    expect(await chooseGenerationProvider({ provider: 'gemini' }, ollamaCurrent, h.io)).toEqual({ provider: 'gemini', confirmed: true });
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
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true }, 'local', false)).toEqual({ run: true });
  });

  it('skips the server runtime, which generates on the team server', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true }, 'server', false)).toEqual({ run: false });
  });

  it('skips when a cancelled key prompt left Ollama in place', () => {
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: false }, 'local', false)).toEqual({ run: false });
  });

  it('says --setup-ollama was ignored when it cannot apply', () => {
    expect(ollamaSetupPlan({ provider: 'claude', confirmed: true }, 'local', true).ignored).toContain('--setup-ollama');
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true }, 'server', true).ignored).toContain('server runtime');
    expect(ollamaSetupPlan({ provider: 'ollama', confirmed: true }, 'local', true).ignored).toBeUndefined();
  });
});
