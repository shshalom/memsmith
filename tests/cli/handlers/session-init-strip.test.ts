import { describe, it, expect } from 'bun:test';
import { buildSessionMetadata } from '../../../src/cli/handlers/session-init.js';

describe('session-init metadata strip', () => {
  it('strips <private> from the prompt in session metadata', () => {
    const m = buildSessionMetadata('MemSmith', 'draft <private>the secret</private> plan');
    expect(m.project).toBe('MemSmith');
    expect(m.prompt).not.toContain('the secret');
    expect(m.prompt).toContain('draft');
    expect(m.prompt).toContain('plan');
  });
  it('leaves a tag-free prompt unchanged (modulo trim)', () => {
    expect(buildSessionMetadata('P', 'hello world').prompt).toBe('hello world');
  });
});
