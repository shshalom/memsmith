import { describe, it, expect } from 'bun:test';
import { embed, embedBatch } from '../../../src/server/generation/embedder.js';

describe('embedder', () => {
  it('returns a 384-dim vector', async () => {
    const v = await embed('team agent memory retrieval');
    expect(v).toHaveLength(384);
    expect(typeof v[0]).toBe('number');
  }, 120000);
  it('is deterministic for the same input', async () => {
    const [a, b] = await Promise.all([embed('same text'), embed('same text')]);
    expect(a).toEqual(b);
  }, 60000);
  it('embeds a batch', async () => {
    const vs = await embedBatch(['a', 'b', 'c']);
    expect(vs).toHaveLength(3);
    expect(vs[0]).toHaveLength(384);
  }, 60000);
});
