import { describe, it, expect } from 'bun:test';
import { scoreObservation } from '../../../src/server/generation/quality.js';

describe('scoreObservation', () => {
  it('scores a rich observation high', () => {
    expect(scoreObservation({
      obsType: 'decision', title: 'Chose Postgres',
      facts: ['relational', 'team knows it', 'pgvector available'],
      narrative: 'We evaluated Mongo and Postgres and picked Postgres for joins and pgvector.',
      concepts: ['storage'],
    })).toBeGreaterThanOrEqual(80);
  });

  it('scores an empty/noise observation low', () => {
    expect(scoreObservation({ narrative: 'ok' })).toBeLessThan(30);
  });

  it('gives decisions/gotchas a type bonus over a plain change', () => {
    const base = { title: 'same', facts: ['a'], narrative: 'a moderately long narrative here' };
    expect(scoreObservation({ ...base, obsType: 'decision' }))
      .toBeGreaterThan(scoreObservation({ ...base, obsType: 'change' }));
  });

  it('never exceeds 100', () => {
    expect(scoreObservation({
      obsType: 'decision', title: 'x'.repeat(40),
      facts: ['a','b','c','d','e'], narrative: 'y'.repeat(200), concepts: ['a','b'],
    })).toBeLessThanOrEqual(100);
  });
});
