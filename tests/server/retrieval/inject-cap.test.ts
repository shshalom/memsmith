import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../../src/server/retrieval/inject.js';
const deps = (rows: any[]) => ({ hybridSearch: async () => rows });
describe('buildInjectionBlock char cap', () => {
  it('never exceeds maxChars, truncating whole items', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ content: 'x'.repeat(500) + `#${i}`, metadata: {} }));
    const block = await buildInjectionBlock(deps(rows), { projectId: 'p', teamId: 't', query: 'q', maxItems: 20, maxChars: 1000 });
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).toContain('Relevant team memory');
  });
  it('defaults to a 10000 char cap when maxChars omitted', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ content: 'y'.repeat(200) + `#${i}`, metadata: {} }));
    const block = await buildInjectionBlock(deps(rows), { projectId: 'p', teamId: 't', query: 'q', maxItems: 200 });
    expect(block.length).toBeLessThanOrEqual(10000);
  });
});
