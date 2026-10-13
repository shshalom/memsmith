import { describe, it, expect } from 'bun:test';
import { classifyHttpProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';

// Observed 2026-10-07: a job that reached Ollama while it restarted got
// `404 model 'qwen2.5:14b' not found`, was classified unrecoverable, and its
// memory was lost although the model was installed.
const notFoundBody = JSON.stringify({ error: { message: "model 'qwen2.5:14b' not found", type: 'not_found_error' } });

describe('Ollama model-not-found classification', () => {
  it('retries a 404 model-not-found from Ollama', () => {
    const error = classifyHttpProviderError({ status: 404, bodyText: notFoundBody, cause: new Error('x'), providerLabel: 'ollama' });
    expect(error.kind).toBe('transient');
  });

  it('fails fast on a 404 for a wrong URL path', () => {
    const error = classifyHttpProviderError({ status: 404, bodyText: '404 page not found', cause: new Error('x'), providerLabel: 'ollama' });
    expect(error.kind).toBe('unrecoverable');
  });

  it('still treats a 404 from a cloud provider as unrecoverable', () => {
    const error = classifyHttpProviderError({ status: 404, bodyText: notFoundBody, cause: new Error('x'), providerLabel: 'OpenRouter' });
    expect(error.kind).toBe('unrecoverable');
  });
});
