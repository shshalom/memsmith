import { describe, it, expect } from 'bun:test';
import { positionForInjection } from '../../../src/server/retrieval/positioning.js';

describe('positionForInjection', () => {
  it('puts the top-ranked item first and the second at the very end', () => {
    const block = positionForInjection(['A-best', 'B-2nd', 'C-3rd', 'D-4th'], 4);
    const lines = block.trim().split('\n').filter(Boolean);
    expect(lines[0]).toContain('A-best');
    expect(lines[lines.length - 1]).toContain('B-2nd');
  });
  it('caps to maxItems', () => {
    const block = positionForInjection(['1','2','3','4','5','6','7'], 3);
    const kept = ['1','2','3','4','5','6','7'].filter(x => block.includes(x));
    expect(kept).toHaveLength(3);
  });
  it('handles empty and single', () => {
    expect(positionForInjection([], 5)).toBe('');
    expect(positionForInjection(['solo'], 5)).toContain('solo');
  });
});
