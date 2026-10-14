// SPDX-License-Identifier: Apache-2.0
//
// The installer saves Gemini and OpenRouter keys to ~/.memsmith/settings.json and
// the Anthropic key to ~/.memsmith/.env, but the server built providers from
// process.env only. A user who picked Gemini in the installer and pasted a key
// got a server that could not generate.
import { describe, it, expect } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import {
  missingGenerationCredential,
  resolveGenerationCredentials,
  type GenerationConfigSources,
} from '../../../src/server/runtime/generation-credentials.js';

function sources(partial: Partial<GenerationConfigSources>): GenerationConfigSources {
  return { env: {}, settings: {}, dotEnv: {}, ...partial };
}

describe('resolveGenerationCredentials', () => {
  it('reads the Gemini key the installer saved to settings.json', () => {
    expect(resolveGenerationCredentials('gemini', sources({ settings: { MEMSMITH_GEMINI_API_KEY: 'g-key' } })).apiKey)
      .toBe('g-key');
  });

  it('reads the OpenRouter key the installer saved to settings.json', () => {
    expect(resolveGenerationCredentials('openrouter', sources({ settings: { MEMSMITH_OPENROUTER_API_KEY: 'or-key' } })).apiKey)
      .toBe('or-key');
  });

  it('reads the Anthropic key the installer saved to ~/.memsmith/.env', () => {
    expect(resolveGenerationCredentials('claude', sources({ dotEnv: { ANTHROPIC_API_KEY: 'sk-ant' } })).apiKey)
      .toBe('sk-ant');
  });

  it('lets the environment override the settings file', () => {
    const creds = resolveGenerationCredentials('gemini', sources({
      env: { MEMSMITH_GEMINI_API_KEY: 'from-env' },
      settings: { MEMSMITH_GEMINI_API_KEY: 'from-file' },
    }));
    expect(creds.apiKey).toBe('from-env');
  });

  it('treats a blank environment value as unset', () => {
    const creds = resolveGenerationCredentials('gemini', sources({
      env: { GEMINI_API_KEY: '' },
      settings: { MEMSMITH_GEMINI_API_KEY: 'from-file' },
    }));
    expect(creds.apiKey).toBe('from-file');
  });

  it('reads the Ollama URL from settings.json', () => {
    expect(resolveGenerationCredentials('ollama', sources({ settings: { MEMSMITH_OLLAMA_URL: 'http://box:11434/v1' } })).baseUrl)
      .toBe('http://box:11434/v1');
  });
});

describe('missingGenerationCredential', () => {
  it('names the key a hosted provider still needs', () => {
    expect(missingGenerationCredential('gemini', sources({}))).toContain('MEMSMITH_GEMINI_API_KEY');
    expect(missingGenerationCredential('claude', sources({}))).toContain('ANTHROPIC_API_KEY');
  });

  it('is null once the key is present, and always null for Ollama', () => {
    expect(missingGenerationCredential('openrouter', sources({ settings: { MEMSMITH_OPENROUTER_API_KEY: 'k' } }))).toBeNull();
    expect(missingGenerationCredential('ollama', sources({}))).toBeNull();
  });
});

describe('instantiateServerGenerationProvider credential sources', () => {
  it('builds a Gemini provider from a key that exists only in settings.json', () => {
    const provider = instantiateServerGenerationProvider('gemini', 'gemini-2.5-flash', sources({
      settings: { MEMSMITH_GEMINI_API_KEY: 'g-key' },
    }));
    expect(provider?.providerLabel).toBe('gemini');
  });

  it('builds a Claude provider from a key that exists only in ~/.memsmith/.env', () => {
    const provider = instantiateServerGenerationProvider('claude', 'claude-haiku-4-5-20251001', sources({
      dotEnv: { ANTHROPIC_API_KEY: 'sk-ant' },
    }));
    expect(provider?.providerLabel).toBe('claude');
  });

  it('still refuses a hosted provider with no key anywhere', () => {
    expect(instantiateServerGenerationProvider('openrouter', undefined, sources({}))).toBeNull();
  });
});
