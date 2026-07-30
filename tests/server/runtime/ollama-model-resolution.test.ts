// SPDX-License-Identifier: Apache-2.0
//
// instantiateServerGenerationProvider read the model from
// process.env.MEMSMITH_SERVER_MODEL only, and otherwise fell back to a
// hardcoded per-provider default. For ollama that default is llama3.1:8b —
// which produces materially worse observations than the configured
// qwen2.5:14b (vague restatements, invented rationale; see the comment at
// settingKeys.ts and the measured 2.86 vs 3.90 quality gap).
//
// Ollama's model lives under its OWN key, MEMSMITH_OLLAMA_MODEL, which nothing
// in this path ever read. The right model only arrived because some other code
// path happened to export it into process.env first — luck, not design. On any
// path without that export, memory would silently be distilled by the model the
// project explicitly rejected.
//
// Same shape as the provider bug fixed earlier: configured in one key, read from
// another, hardcoded default silently winning.
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
      // The last-resort fallback is qwen, NOT llama3.1:8b — if it ever fires it
      // must not silently downgrade the quality of stored memory.
      expect(modelOf(p)).toBe('qwen2.5:14b');
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
