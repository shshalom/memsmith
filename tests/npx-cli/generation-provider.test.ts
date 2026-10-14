// SPDX-License-Identifier: Apache-2.0
//
// The installer asked "Which memory provider do you want to use?", recommended
// Claude, and saved the answer as MEMSMITH_PROVIDER, a key generation never
// reads. The server generated with Ollama (MEMSMITH_SERVER_PROVIDER, default
// ollama) no matter what the user picked.
import { describe, it, expect } from 'bun:test';
import {
  GENERATION_PROVIDER_CHOICES,
  initialGenerationProvider,
  providerSettingsUpdates,
} from '../../src/npx-cli/install/generation-provider.js';
import { resolveGenerationProviderName } from '../../src/server/runtime/resolve-generation-provider.js';

describe('provider prompt choices', () => {
  it('lists Ollama first and recommends it', () => {
    expect(GENERATION_PROVIDER_CHOICES.map((c) => c.value)).toEqual(['ollama', 'claude', 'gemini', 'openrouter']);
    expect(GENERATION_PROVIDER_CHOICES[0].label).toContain('recommended');
    expect(GENERATION_PROVIDER_CHOICES.slice(1).some((c) => c.label.includes('recommended'))).toBe(false);
  });
});

describe('initialGenerationProvider', () => {
  it('defaults to Ollama on a fresh install', () => {
    expect(initialGenerationProvider({}, {})).toBe('ollama');
  });

  it('ignores the legacy MEMSMITH_PROVIDER key that generation never read', () => {
    expect(initialGenerationProvider({ MEMSMITH_PROVIDER: 'claude' }, {})).toBe('ollama');
  });

  it('starts from the provider generation actually uses', () => {
    expect(initialGenerationProvider({ MEMSMITH_SERVER_PROVIDER: 'gemini' }, {})).toBe('gemini');
    expect(initialGenerationProvider({ MEMSMITH_SERVER_PROVIDER: 'gemini' }, { MEMSMITH_SERVER_PROVIDER: 'openrouter' })).toBe('openrouter');
  });

  it('falls back to Ollama when the saved provider is not a known one', () => {
    expect(initialGenerationProvider({ MEMSMITH_SERVER_PROVIDER: 'gpt' }, {})).toBe('ollama');
  });
});

describe('providerSettingsUpdates', () => {
  it('selecting Claude writes the key the server resolves the provider from', () => {
    const updates = providerSettingsUpdates('claude', {});
    expect(updates.MEMSMITH_SERVER_PROVIDER).toBe('claude');
    expect(resolveGenerationProviderName({}, updates)).toBe('claude');
    expect(updates).not.toHaveProperty('MEMSMITH_PROVIDER');
  });

  it('selecting Gemini writes the provider, a Gemini model, and the pasted key', () => {
    const updates = providerSettingsUpdates('gemini', { apiKey: 'g-key' });
    expect(updates.MEMSMITH_SERVER_PROVIDER).toBe('gemini');
    expect(updates.MEMSMITH_SERVER_MODEL).toMatch(/^gemini-/);
    expect(updates.MEMSMITH_GEMINI_API_KEY).toBe('g-key');
  });

  it('never writes a provider model that belongs to another provider', () => {
    // The model registry default is qwen2.5:14b; a hosted provider handed that
    // model fails every request.
    for (const provider of ['claude', 'gemini', 'openrouter'] as const) {
      expect(providerSettingsUpdates(provider, {}).MEMSMITH_SERVER_MODEL).not.toBe('qwen2.5:14b');
    }
    expect(providerSettingsUpdates('claude', { current: { provider: 'ollama', model: 'qwen2.5:14b' } }).MEMSMITH_SERVER_MODEL)
      .not.toBe('qwen2.5:14b');
  });

  it('selecting Ollama writes qwen2.5:14b to both model keys the server reads', () => {
    const updates = providerSettingsUpdates('ollama', {});
    expect(updates).toEqual({
      MEMSMITH_SERVER_PROVIDER: 'ollama',
      MEMSMITH_SERVER_MODEL: 'qwen2.5:14b',
      MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b',
    });
  });

  it('keeps a custom model on reinstall when the provider does not change', () => {
    expect(providerSettingsUpdates('ollama', { current: { provider: 'ollama', model: 'llama3.3:70b' } }).MEMSMITH_SERVER_MODEL)
      .toBe('llama3.3:70b');
  });

  it('an explicit --model wins', () => {
    expect(providerSettingsUpdates('openrouter', { model: 'openai/gpt-5-mini' }).MEMSMITH_SERVER_MODEL).toBe('openai/gpt-5-mini');
  });

  it('does not write an API key setting it was not given', () => {
    expect(providerSettingsUpdates('gemini', {})).not.toHaveProperty('MEMSMITH_GEMINI_API_KEY');
  });
});
