// SPDX-License-Identifier: Apache-2.0
//
// The installer saves Gemini and OpenRouter keys to ~/.memsmith/settings.json and
// the Anthropic key to ~/.memsmith/.env, but the server built providers from
// process.env only. A user who picked Gemini in the installer and pasted a key
// got a server that could not generate.
import { describe, it, expect } from 'bun:test';
import { buildGenerationProvider, instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
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

  it('prefers the saved Anthropic key over one inherited from the shell', () => {
    const creds = resolveGenerationCredentials('claude', sources({
      env: { ANTHROPIC_API_KEY: 'from-shell', MEMSMITH_SERVER_PROVIDER: 'claude' },
      dotEnv: { ANTHROPIC_API_KEY: 'from-dotenv' },
    }));
    expect(creds.apiKey).toBe('from-dotenv');
  });

  it('lets MEMSMITH_ANTHROPIC_API_KEY override the saved key', () => {
    const creds = resolveGenerationCredentials('claude', sources({
      env: { MEMSMITH_ANTHROPIC_API_KEY: 'memsmith-env', ANTHROPIC_API_KEY: 'from-shell' },
      dotEnv: { ANTHROPIC_API_KEY: 'from-dotenv' },
    }));
    expect(creds.apiKey).toBe('memsmith-env');
  });

  // Ruling R8: an unrelated project's ANTHROPIC_API_KEY must not turn on Claude generation.
  it('ignores a shell ANTHROPIC_API_KEY when the provider comes from the settings file or the default', () => {
    expect(resolveGenerationCredentials('claude', sources({ env: { ANTHROPIC_API_KEY: 'from-shell' } })).apiKey).toBeUndefined();
    expect(resolveGenerationCredentials('claude', sources({
      env: { ANTHROPIC_API_KEY: 'from-shell' },
      settings: { MEMSMITH_SERVER_PROVIDER: 'claude' },
    })).apiKey).toBeUndefined();
  });

  it('uses a shell ANTHROPIC_API_KEY when env MEMSMITH_SERVER_PROVIDER or a team override chose the provider', () => {
    expect(resolveGenerationCredentials('claude', sources({
      env: { ANTHROPIC_API_KEY: 'from-shell', MEMSMITH_SERVER_PROVIDER: 'claude' },
    })).apiKey).toBe('from-shell');
    expect(resolveGenerationCredentials('claude', sources({
      env: { ANTHROPIC_API_KEY: 'from-shell' },
      explicitProvider: true,
    })).apiKey).toBe('from-shell');
  });

  for (const [provider, memsmithVar, genericVar] of [
    ['gemini', 'MEMSMITH_GEMINI_API_KEY', 'GEMINI_API_KEY'],
    ['openrouter', 'MEMSMITH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  ] as const) {
    it(`${provider}: MemSmith env var > saved settings > generic shell var`, () => {
      const all = sources({
        env: { [memsmithVar]: 'memsmith-env', [genericVar]: 'generic-shell' },
        settings: { [memsmithVar]: 'saved' },
      });
      expect(resolveGenerationCredentials(provider, all).apiKey).toBe('memsmith-env');
      const noMemsmithEnv = sources({ env: { [genericVar]: 'generic-shell' }, settings: { [memsmithVar]: 'saved' } });
      expect(resolveGenerationCredentials(provider, noMemsmithEnv).apiKey).toBe('saved');
      expect(resolveGenerationCredentials(provider, sources({ env: { [genericVar]: 'generic-shell' } })).apiKey).toBe('generic-shell');
    });
  }

  it('treats a blank environment value as unset', () => {
    const creds = resolveGenerationCredentials('gemini', sources({
      env: { MEMSMITH_GEMINI_API_KEY: '' },
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

  it('a team-chosen Claude provider builds from a shell key, a file or default one does not', () => {
    const shellKey = sources({ env: { ANTHROPIC_API_KEY: 'from-shell' } });
    const spec = { provider: 'claude', model: 'claude-haiku-5-5', fallback: 'none', fallbackModel: 'gemma4:12b' };
    expect(buildGenerationProvider({ ...spec, explicitProvider: true }, shellKey)?.providerLabel).toBe('claude');
    expect(buildGenerationProvider({ ...spec, explicitProvider: false }, shellKey)).toBeNull();
  });

  it('still refuses a hosted provider with no key anywhere', () => {
    expect(instantiateServerGenerationProvider('openrouter', undefined, sources({}))).toBeNull();
  });
});
