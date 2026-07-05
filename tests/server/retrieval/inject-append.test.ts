import { describe, it, expect } from 'bun:test';
import { appendTeamMemoryInjection } from '../../../src/server/retrieval/inject-append.js';

describe('appendTeamMemoryInjection', () => {
  it('puts the team block first, existing context after', () => {
    const out = appendTeamMemoryInjection('EXISTING', '## Relevant team memory\n- x');
    expect(out.indexOf('team memory')).toBeLessThan(out.indexOf('EXISTING'));
  });
  it('returns existing unchanged when injection is empty', () => {
    expect(appendTeamMemoryInjection('EXISTING', '')).toBe('EXISTING');
  });
  it('returns injection alone when existing is empty', () => {
    expect(appendTeamMemoryInjection('', '## team\n- x')).toBe('## team\n- x');
  });
  it('empty + empty -> empty', () => {
    expect(appendTeamMemoryInjection('', '')).toBe('');
  });
});
