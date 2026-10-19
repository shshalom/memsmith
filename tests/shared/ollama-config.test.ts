// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { getOllamaConfig } from '../../src/shared/ollama-config.js';

describe('getOllamaConfig', () => {
  it('returns a keyless config with the native chat apiUrl and a default model', () => {
    const cfg = getOllamaConfig();
    expect(cfg.apiKey).toBe('ollama-local');
    expect(cfg.apiUrl.endsWith('/api/chat')).toBe(true);
    expect(typeof cfg.model).toBe('string');
    expect(cfg.model.length).toBeGreaterThan(0);
  });
});
