import { describe, test, expect } from 'bun:test';
import { tierToBudget } from '../../../src/server/retrieval/tiering.js';

const mk = (id: string, chars: number) => ({
  content: `${id}:` + 'x'.repeat(chars),
  metadata: { title: `T-${id}`, facts: [`fact-${id}`], why: `why-${id}` },
});

describe('tierToBudget', () => {
  test('keeps all items by stepping down rather than dropping', () => {
    const ranked = [mk('a', 200), mk('b', 200), mk('c', 200), mk('d', 200)];
    // full detail (~200 each) would blow a 300 budget and drop 3 items;
    // tiering should keep more items at reduced detail.
    const out = tierToBudget(ranked, { maxChars: 300, maxItems: 5 });
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('\n').length).toBeLessThanOrEqual(300);
  });
  test('rank-graduation: top stays fuller than bottom', () => {
    const ranked = [mk('a', 120), mk('b', 120), mk('c', 120)];
    const out = tierToBudget(ranked, { maxChars: 160, maxItems: 5 });
    // top item should retain more than the last (more chars or the full blob)
    expect(out[0].length).toBeGreaterThanOrEqual(out[out.length - 1].length);
  });
  test('respects maxItems cap', () => {
    const ranked = [mk('a', 10), mk('b', 10), mk('c', 10), mk('d', 10), mk('e', 10), mk('f', 10)];
    const out = tierToBudget(ranked, { maxChars: 100000, maxItems: 3 });
    expect(out.length).toBe(3);
  });
  test('single oversized L0 is hard-sliced, not emptied', () => {
    const big = { content: 'z'.repeat(500), metadata: {} }; // no title -> L0 = first line = 500 chars
    const out = tierToBudget([big], { maxChars: 50, maxItems: 5 });
    expect(out.length).toBe(1);
    expect(out[0].length).toBeLessThanOrEqual(50);
  });
  test('empty input -> empty output', () => {
    expect(tierToBudget([], { maxChars: 100, maxItems: 5 })).toEqual([]);
  });
});
