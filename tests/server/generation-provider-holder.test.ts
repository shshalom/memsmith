// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { GenerationProviderHolder } from '../../src/server/generation/GenerationProviderHolder.js';

function resolverStub(get: () => { provider: string; model: string }) {
  return {
    provider: async () => get().provider,
    resolve: async () => ({ value: get().model, source: 'file' }),
    fallback: async () => 'ollama',
    fallbackModel: async () => 'gemma4:12b',
  } as any;
}

describe('GenerationProviderHolder', () => {
  it('builds once and caches by (provider,model)', async () => {
    let builds = 0;
    const holder = new GenerationProviderHolder(
      resolverStub(() => ({ provider: 'ollama', model: 'qwen2.5:14b' })),
      (spec) => { builds++; return { id: `${spec.provider}::${spec.model}` } as any; },
    );
    const a = await holder.current('t');
    const b = await holder.current('t');
    expect(builds).toBe(1);
    expect(a).toBe(b);
  });

  it('rebuilds when the resolved provider changes', async () => {
    let provider = 'ollama';
    const resolver = resolverStub(() => ({ provider, model: 'm' }));
    let builds = 0;
    const holder = new GenerationProviderHolder(resolver, (spec) => { builds++; return { id: `${spec.provider}::${spec.model}` } as any; });
    await holder.current('t');
    provider = 'claude';
    const after = await holder.current('t');
    expect(builds).toBe(2);
    expect((after as any).id).toBe('claude::m');
  });

  it('keeps last-good provider when a build fails', async () => {
    let provider = 'ollama';
    const resolver = resolverStub(() => ({ provider, model: 'm' }));
    const holder = new GenerationProviderHolder(resolver, (spec) => (spec.provider === 'claude' ? null : ({ id: spec.provider } as any)));
    const good = await holder.current('t');
    provider = 'claude';
    const after = await holder.current('t');
    expect(after).toBe(good);
  });
});
