// SPDX-License-Identifier: Apache-2.0
//
// The laptop generation loop resolves its provider on every pass. Rebuilding it
// each time reset the failover cooldown, so a dead hosted provider was retried
// on every pass instead of once per cooldown window.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GenerationProviderCache } from '../../../src/server/generation/GenerationProviderHolder.js';
import { resolveLaptopGenerationProvider } from '../../../src/services/generation/start-generation-loop.js';

const ENV_KEYS = ['MEMSMITH_SERVER_PROVIDER', 'MEMSMITH_OLLAMA_MODEL', 'MEMSMITH_SERVER_FALLBACK', 'MEMSMITH_SERVER_FALLBACK_MODEL'];

describe('resolveLaptopGenerationProvider', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.MEMSMITH_SERVER_PROVIDER = 'ollama';
    process.env.MEMSMITH_OLLAMA_MODEL = 'gemma4:12b';
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reuses one provider across passes while the spec is unchanged', async () => {
    const cache = new GenerationProviderCache();
    const first = await resolveLaptopGenerationProvider(cache);
    const second = await resolveLaptopGenerationProvider(cache);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('rebuilds when the resolved spec changes', async () => {
    const cache = new GenerationProviderCache();
    const first = await resolveLaptopGenerationProvider(cache);
    process.env.MEMSMITH_OLLAMA_MODEL = 'qwen2.5:14b';
    const second = await resolveLaptopGenerationProvider(cache);
    expect(second).not.toBe(first);
    expect((second as unknown as { model: string }).model).toBe('qwen2.5:14b');
  });

  it('shares one cache across calls when none is passed', async () => {
    const first = await resolveLaptopGenerationProvider();
    expect(await resolveLaptopGenerationProvider()).toBe(first);
  });
});
