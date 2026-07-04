import { describe, it, expect } from 'bun:test';
import { scoreRecallAtK, mrr } from '../../bench/longmemeval/run.js';

describe('benchmark scoring', () => {
  it('recall@k = 1 when a gold id is in the top k', () => {
    expect(scoreRecallAtK(['x', 'g', 'y'], ['g'], 5)).toBe(1);
  });
  it('recall@k = 0 when no gold id is in the top k', () => {
    expect(scoreRecallAtK(['x', 'y', 'z'], ['g'], 2)).toBe(0);
  });
  it('recall@k respects k cutoff', () => {
    expect(scoreRecallAtK(['x', 'y', 'g'], ['g'], 2)).toBe(0);
    expect(scoreRecallAtK(['x', 'y', 'g'], ['g'], 3)).toBe(1);
  });
  it('mrr returns reciprocal of first gold rank', () => {
    expect(mrr(['x', 'g', 'y'], ['g'])).toBeCloseTo(1 / 2, 5);
  });
});
