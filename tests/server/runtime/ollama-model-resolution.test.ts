// SPDX-License-Identifier: Apache-2.0
//
// instantiateServerGenerationProvider once read the model from
// process.env.MEMSMITH_SERVER_MODEL only, so an Ollama model configured in
// settings was silently replaced by a hardcoded per-provider default (then
// llama3.1:8b, which wrote materially worse observations). A model passed in
// must always win, and the hardcoded default applies only when nothing is
// configured anywhere.
import { describe, it, expect } from 'bun:test';
import { instantiateServerGenerationProvider } from '../../../src/server/runtime/create-server-service.js';

function modelOf(p: unknown): string {
  return (p as { model?: string } & Record<string, unknown>)?.model
    ?? String((p as Record<string, unknown>)?.['model'] ?? '');
}

describe('ollama model resolution', () => {
  it('uses the model it is given rather than the hardcoded fallback', () => {
    const p = instantiateServerGenerationProvider('ollama', 'qwen2.5:14b');
    expect(p).not.toBeNull();
    expect(modelOf(p)).toBe('qwen2.5:14b');
  });

  it('REGRESSION: does not silently fall back to llama3.1:8b when a model is supplied', () => {
    // The failure this pins: an explicitly configured qwen being replaced by the
    // 8B model, degrading every observation generated from that point on.
    const p = instantiateServerGenerationProvider('ollama', 'qwen2.5:14b');
    expect(modelOf(p)).not.toBe('llama3.1:8b');
  });

  it('still falls back when nothing is configured anywhere', () => {
    // A fallback is correct as a last resort — the bug was it winning over a
    // real setting, not that it exists.
    const before = process.env.MEMSMITH_SERVER_MODEL;
    delete process.env.MEMSMITH_SERVER_MODEL;
    try {
      const p = instantiateServerGenerationProvider('ollama');
      expect(modelOf(p)).toBe('gemma4:12b');
    } finally {
      if (before !== undefined) process.env.MEMSMITH_SERVER_MODEL = before;
    }
  });

  it('an explicit model beats the environment', () => {
    const before = process.env.MEMSMITH_SERVER_MODEL;
    process.env.MEMSMITH_SERVER_MODEL = 'from-env';
    try {
      expect(modelOf(instantiateServerGenerationProvider('ollama', 'explicit'))).toBe('explicit');
    } finally {
      if (before === undefined) delete process.env.MEMSMITH_SERVER_MODEL;
      else process.env.MEMSMITH_SERVER_MODEL = before;
    }
  });
});
