import { describe, it, expect } from 'bun:test';
import { detectRediscovery } from '../../../src/server/retrieval/rediscovery.js';

const deps = (rows: any[]) => ({ hybridSearch: async () => rows });

describe('detectRediscovery', () => {
  it('flags when memory already held a strong match for the query', async () => {
    const r = await detectRediscovery(deps([{ id: 'o1', content: 'PaymentService retries on 500', metadata: {} }]),
      { projectId: 'p1', teamId: 'tm1', toolQuery: 'PaymentService', toolResult: '...' });
    expect(r.rediscovered).toBe(true);
    expect(r.matchedIds).toContain('o1');
  });
  it('does not flag when memory had nothing', async () => {
    const r = await detectRediscovery(deps([]), { projectId: 'p1', teamId: 'tm1', toolQuery: 'BrandNewThing', toolResult: '...' });
    expect(r.rediscovered).toBe(false);
  });
  it('does not flag on an empty query', async () => {
    const r = await detectRediscovery(deps([{ id: 'x', content: 'y', metadata: {} }]), { projectId: 'p1', teamId: 'tm1', toolQuery: '   ', toolResult: '...' });
    expect(r.rediscovered).toBe(false);
    expect(r.matchedIds).toEqual([]);
  });
});
