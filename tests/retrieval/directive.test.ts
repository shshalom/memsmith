// tests/retrieval/directive.test.ts
import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE } from '../../src/services/retrieval/directive.js';

describe('MEMORY_FIRST_DIRECTIVE', () => {
  it('lays out know, remember, validate, in that order', () => {
    const know = MEMORY_FIRST_DIRECTIVE.indexOf('already know it from this conversation');
    const remember = MEMORY_FIRST_DIRECTIVE.indexOf('search MemSmith memory');
    const validate = MEMORY_FIRST_DIRECTIVE.indexOf('Validate');
    expect(know).toBeGreaterThan(-1);
    expect(remember).toBeGreaterThan(know);
    expect(validate).toBeGreaterThan(remember);
  });

  it('puts memory before code and web searches, for questions the agent asks itself too', () => {
    expect(MEMORY_FIRST_DIRECTIVE).toContain('BEFORE grepping, globbing, or searching the web');
    expect(MEMORY_FIRST_DIRECTIVE).toContain('asking yourself mid-task');
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).not.toContain('claude-mem');
  });
});
