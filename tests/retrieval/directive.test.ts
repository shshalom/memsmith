// tests/retrieval/directive.test.ts
import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE } from '../../src/services/retrieval/directive.js';

describe('MEMORY_FIRST_DIRECTIVE', () => {
  it('lays out know, then remember, then validate', () => {
    const steps = ['1.', '2.', '3.'].map(step => MEMORY_FIRST_DIRECTIVE.indexOf(step));
    expect(steps.every(i => i > -1)).toBe(true);
    expect(steps[0]).toBeLessThan(steps[1]);
    expect(steps[1]).toBeLessThan(steps[2]);
    expect(MEMORY_FIRST_DIRECTIVE.slice(steps[1], steps[2])).toContain('memory');
    expect(MEMORY_FIRST_DIRECTIVE.slice(steps[2]).toLowerCase()).toContain('validate');
  });
});
