import { describe, test, expect } from 'bun:test';
import { renderAtTier } from '../../../src/server/retrieval/tiering.js';

const rich = {
  content: 'FULL CONTENT BLOB\n\nnarrative...\n- f1\n- f2',
  metadata: { title: 'Chose Postgres', subtitle: 'over SQLite', facts: ['concurrent writers', 'pgvector'], why: 'need multi-writer + vectors' },
};
const legacy = { content: 'first line\nsecond line', metadata: {} };

describe('renderAtTier', () => {
  test('L0 = title (+subtitle)', () => {
    expect(renderAtTier(rich, 0)).toBe('Chose Postgres — over SQLite');
  });
  test('L1 = title + facts', () => {
    const r = renderAtTier(rich, 1);
    expect(r).toContain('Chose Postgres');
    expect(r).toContain('- concurrent writers');
    expect(r).toContain('- pgvector');
    expect(r).not.toContain('need multi-writer');
  });
  test('L2 = title + facts + why', () => {
    const r = renderAtTier(rich, 2);
    expect(r).toContain('- pgvector');
    expect(r).toContain('Why: need multi-writer + vectors');
  });
  test('L3 = full content verbatim', () => {
    expect(renderAtTier(rich, 3)).toBe(rich.content);
  });
  test('missing why: L2 equals L1', () => {
    const noWhy = { content: 'c', metadata: { title: 'T', facts: ['a'] } };
    expect(renderAtTier(noWhy, 2)).toBe(renderAtTier(noWhy, 1));
  });
  test('missing facts: L1 equals L0', () => {
    const noFacts = { content: 'c', metadata: { title: 'T' } };
    expect(renderAtTier(noFacts, 1)).toBe(renderAtTier(noFacts, 0));
  });
  test('legacy row (no structured metadata): L0 = first line, L3 = full content', () => {
    expect(renderAtTier(legacy, 0)).toBe('first line');
    expect(renderAtTier(legacy, 3)).toBe('first line\nsecond line');
  });
  test('never throws on malformed metadata', () => {
    const bad = { content: 'x', metadata: { title: 42, facts: 'not-an-array', why: {} } as any };
    expect(() => renderAtTier(bad, 2)).not.toThrow();
    expect(typeof renderAtTier(bad, 2)).toBe('string');
  });
});
