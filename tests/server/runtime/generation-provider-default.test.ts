// SPDX-License-Identifier: Apache-2.0
//
// A fresh install once generated nothing: the boot path read only
// process.env.MEMSMITH_SERVER_PROVIDER, while MemSmith's settings live in
// ~/.memsmith/settings.json, so the registry default never applied and every
// job sat queued forever.
import { describe, it, expect } from 'bun:test';
import {
  resolveBootGenerationSpec,
  resolveGenerationProviderName,
} from '../../../src/server/runtime/resolve-generation-provider.js';

describe('generation provider resolution', () => {
  it('falls back to the registry default when nothing is configured', () => {
    // The bug: this returned '' / null, so a fresh install never generated.
    expect(resolveGenerationProviderName({}, {})).toBe('claude');
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
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: '' }, {})).toBe('claude');
    expect(resolveGenerationProviderName({ MEMSMITH_SERVER_PROVIDER: '   ' }, {})).toBe('claude');
    expect(resolveGenerationProviderName({}, { MEMSMITH_SERVER_PROVIDER: '' })).toBe('claude');
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

describe('boot generation spec', () => {
  it('defaults to Claude with an Ollama gemma4:12b backup', () => {
    expect(resolveBootGenerationSpec({}, {})).toEqual({
      provider: 'claude',
      fallback: 'ollama',
      fallbackModel: 'gemma4:12b',
    });
  });

  it('a pinned legacy install keeps its model even when the Ollama default changed', () => {
    const settings = {
      MEMSMITH_SERVER_PROVIDER: 'ollama',
      MEMSMITH_SERVER_MODEL: 'qwen2.5:14b',
      MEMSMITH_OLLAMA_MODEL: 'gemma4:12b',
    };
    expect(resolveBootGenerationSpec({}, settings)?.model).toBe('qwen2.5:14b');
  });

  it('for Ollama, env MEMSMITH_SERVER_MODEL outranks the settings file', () => {
    const spec = resolveBootGenerationSpec(
      { MEMSMITH_SERVER_MODEL: 'llama3.3:70b' },
      { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' },
    );
    expect(spec?.model).toBe('llama3.3:70b');
  });

  it('for Ollama with no generation model, uses MEMSMITH_OLLAMA_MODEL, then gemma4:12b', () => {
    expect(resolveBootGenerationSpec({}, { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'mistral:7b' })?.model).toBe('mistral:7b');
    expect(resolveBootGenerationSpec({}, { MEMSMITH_SERVER_PROVIDER: 'ollama' })?.model).toBe('gemma4:12b');
  });

  it('reads the fallback settings, with env winning', () => {
    const spec = resolveBootGenerationSpec(
      { MEMSMITH_SERVER_FALLBACK: 'NONE' },
      { MEMSMITH_SERVER_FALLBACK: 'ollama', MEMSMITH_SERVER_FALLBACK_MODEL: 'qwen2.5:14b' },
    );
    expect(spec).toMatchObject({ fallback: 'none', fallbackModel: 'qwen2.5:14b' });
  });

  it('ignores an unknown fallback value', () => {
    expect(resolveBootGenerationSpec({}, { MEMSMITH_SERVER_FALLBACK: 'cloud' })?.fallback).toBe('ollama');
  });

  it('returns null for an unknown provider', () => {
    expect(resolveBootGenerationSpec({ MEMSMITH_SERVER_PROVIDER: 'gpt' }, {})).toBeNull();
  });
});
