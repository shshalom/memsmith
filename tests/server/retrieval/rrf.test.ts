import { describe, it, expect } from 'bun:test';
import { combineRanks } from '../../../src/server/retrieval/rrf.js';

describe('combineRanks (RRF)', () => {
  it('fuses two ranked lists, rewarding items ranked high in both', () => {
    const fts = [{ id: 'a', rank: 0 }, { id: 'b', rank: 1 }, { id: 'c', rank: 2 }];
    const vec = [{ id: 'b', rank: 0 }, { id: 'a', rank: 1 }, { id: 'd', rank: 2 }];
    const fused = combineRanks([fts, vec], 60);
    expect(fused[0].id === 'a' || fused[0].id === 'b').toBe(true);
    expect(fused.map(f => f.id)).toContain('d');
    for (let i = 1; i < fused.length; i++) expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
  });

  it('handles a single list', () => {
    const fused = combineRanks([[{ id: 'x', rank: 0 }]], 60);
    expect(fused).toEqual([{ id: 'x', score: 1 / 60 }]);
  });

  it('handles empty input', () => {
    expect(combineRanks([], 60)).toEqual([]);
  });
});
