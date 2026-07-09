// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { GenerationProviderHolder } from '../../src/server/generation/GenerationProviderHolder.js';

function resolverStub(provider: string, model: string) {
  return { provider: async () => provider, model: async () => model } as any;
}

describe('GenerationProviderHolder', () => {
  it('builds once and caches by (provider,model)', async () => {
    let builds = 0;
    const holder = new GenerationProviderHolder(
      resolverStub('ollama', 'qwen2.5:14b'),
      (p, m) => { builds++; return { id: `${p}::${m}` } as any; },
    );
    const a = await holder.current('t');
    const b = await holder.current('t');
    expect(builds).toBe(1);
    expect(a).toBe(b);
  });

  it('rebuilds when the resolved provider changes', async () => {
    let provider = 'ollama';
    const resolver = { provider: async () => provider, model: async () => 'm' } as any;
    let builds = 0;
    const holder = new GenerationProviderHolder(resolver, (p, m) => { builds++; return { id: `${p}::${m}` } as any; });
    await holder.current('t');
    provider = 'claude';
    const after = await holder.current('t');
    expect(builds).toBe(2);
    expect((after as any).id).toBe('claude::m');
  });

  it('keeps last-good provider when a build fails', async () => {
    let provider = 'ollama';
    const resolver = { provider: async () => provider, model: async () => 'm' } as any;
    const holder = new GenerationProviderHolder(resolver, (p) => (p === 'claude' ? null : ({ id: p } as any)));
    const good = await holder.current('t');
    provider = 'claude'; // build returns null
    const after = await holder.current('t');
    expect(after).toBe(good);
  });
});
