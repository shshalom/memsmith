// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import { OllamaObservationProvider } from '../../../src/server/generation/providers/OllamaObservationProvider.js';

describe('instantiateServerGenerationProvider — ollama', () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env.MEMSMITH_SERVER_MODEL = prev.MEMSMITH_SERVER_MODEL;
    process.env.MEMSMITH_OLLAMA_URL = prev.MEMSMITH_OLLAMA_URL;
    process.env.MEMSMITH_OLLAMA_API_KEY = prev.MEMSMITH_OLLAMA_API_KEY;
  });

  it('instantiates Ollama without any API key (keyless)', () => {
    delete process.env.MEMSMITH_OLLAMA_API_KEY;
    delete process.env.MEMSMITH_SERVER_MODEL;
    const provider = instantiateServerGenerationProvider('ollama');
    expect(provider).toBeInstanceOf(OllamaObservationProvider);
    expect(provider?.providerLabel).toBe('ollama');
  });
});
