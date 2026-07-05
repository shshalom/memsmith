// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { expandQuery } from '../../../src/server/retrieval/query-expansion.js';

describe('expandQuery', () => {
  it('always retains the original query as the first variant', () => {
    const v = expandQuery('How long is my commute to work?');
    expect(v[0]).toBe('How long is my commute to work?');
  });

  it('produces a de-framed variant that strips interrogative framing and the trailing ?', () => {
    const v = expandQuery('How long is my commute to work?');
    // The de-framed variant drops "how long is my" and the "?".
    expect(v.length).toBeGreaterThan(1);
    const deframed = v[1].toLowerCase();
    expect(deframed).not.toContain('how long');
    expect(deframed).not.toContain('?');
    expect(deframed).toContain('commute');
    expect(deframed).toContain('work');
  });

  it('strips a variety of question framings', () => {
    expect(expandQuery('What was my previous occupation?')[1].toLowerCase()).not.toContain('what was');
    expect(expandQuery('Can you recommend a show for me to watch tonight?')[1].toLowerCase()).not.toContain('can you recommend');
    expect(expandQuery('What was my previous occupation?')[1].toLowerCase()).toContain('occupation');
  });

  it('is deterministic', () => {
    expect(expandQuery('How long is my commute?')).toEqual(expandQuery('How long is my commute?'));
  });

  it('deduplicates: a query with no strippable framing yields just the original', () => {
    // No leading interrogative framing to strip → de-framed equals original → deduped to one.
    const v = expandQuery('project deadline next Tuesday');
    expect(v).toEqual(['project deadline next Tuesday']);
  });

  it('never returns empty variants', () => {
    for (const q of ['How long is my commute?', 'What?', 'x', 'Can you recommend something?']) {
      const v = expandQuery(q);
      expect(v.length).toBeGreaterThan(0);
      for (const s of v) expect(s.trim().length).toBeGreaterThan(0);
    }
  });
});
