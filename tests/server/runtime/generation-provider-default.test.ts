// SPDX-License-Identifier: Apache-2.0
//
// A fresh local install never generated a single observation. The setting
// registry declares the generation provider's default as 'ollama' — "runs a
// local model on your machine (private, free, no API key)" — but the boot path
// read process.env.MEMSMITH_SERVER_PROVIDER and returned null when empty.
// MemSmith's settings live in ~/.memsmith/settings.json, not the process
// environment, so the declared default never applied: generation stayed
// disabled and every job sat queued forever unless the operator hand-exported
// an env var.
//
// This is the same class of defect as three others found on 2026-07-27 —
// configuration written to settings.json but read from process.env.
import { describe, it, expect } from 'bun:test';
import { resolveGenerationProviderName } from '../../../src/server/runtime/resolve-generation-provider.js';

describe('generation provider resolution', () => {
  it('falls back to the registry default when nothing is configured', () => {
    // The bug: this returned '' / null, so a fresh install never generated.
    expect(resolveGenerationProviderName({}, {})).toBe('ollama');
  });

  it('prefers an explicit env var (deployments set it that way)', () => {
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: 'claude' }, {})).toBe('claude');
  });

  it('reads the value from settings when the env var is absent', () => {
    expect(resolveGenerationProviderName({}, { MEMSMITH_SERVER_PROVIDER: 'gemini' })).toBe('gemini');
  });

  it('lets env win over settings', () => {
    expect(resolveGenerationProviderName(
      { MEMSMITH_SERVER_PROVIDER: 'claude' },
      { MEMSMITH_SERVER_PROVIDER: 'gemini' },
    )).toBe('claude');
  });

  it('treats empty or whitespace-only values as unset', () => {
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: '' }, {})).toBe('ollama');
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: '   ' }, {})).toBe('ollama');
    expect(resolveGenerationProviderName({}, { MEMSMITH_SERVER_PROVIDER: '' })).toBe('ollama');
  });

  it('normalises case so "Ollama" is not treated as a different provider', () => {
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: 'OLLAMA' }, {})).toBe('ollama');
  });

  it('rejects an unknown provider rather than silently defaulting', () => {
    // Silently falling back would hide a typo and generate with the wrong
    // provider; returning null lets the caller log and disable explicitly.
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: 'not-a-provider' }, {})).toBeNull();
  });
});
