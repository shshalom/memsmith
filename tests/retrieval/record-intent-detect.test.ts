// tests/retrieval/record-intent-detect.test.ts
import { describe, it, expect } from 'bun:test';
import { isRecordIntent } from '../../src/services/retrieval/record-intent-detect';

describe('isRecordIntent', () => {
  it('matches imperative record phrasings', () => {
    for (const p of ['Save this: X', 'park this idea — Y', 'mark this: Z', 'note this: W', 'record that Q']) {
      expect(isRecordIntent(p)).toBe(true);
    }
  });
  it('matches declarative record phrasings (the ones that leaked)', () => {
    for (const p of ['Remember that the port is 55433', 'Log that we shipped X',
                     'note for later that Y', 'keep in mind that Z', "don't forget that W"]) {
      expect(isRecordIntent(p)).toBe(true);
    }
  });
  it('does not match questions, statements, or commands', () => {
    for (const p of ['what did we decide about the db?', 'the build passes now',
                     'run the tests and show failures', 'fix the embed-on-write gap', 'open the dashboard']) {
      expect(isRecordIntent(p)).toBe(false);
    }
  });
  it('never throws on odd input', () => {
    expect(isRecordIntent('')).toBe(false);
    expect(isRecordIntent('   ')).toBe(false);
  });
});
