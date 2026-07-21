// tests/cli/handlers/record-intent-client-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { stripRecordIntentPrompt } from '../../../src/cli/handlers/record-intent.js';

describe('record-intent client strip', () => {
  it('strips <private> from the prompt before it is sent', () => {
    const out = stripRecordIntentPrompt('remember <private>my password</private> please');
    expect(out).not.toContain('my password');
    expect(out).toContain('remember');
    expect(out).toContain('please');
  });
  it('leaves a tag-free prompt unchanged', () => {
    expect(stripRecordIntentPrompt('just remember this')).toBe('just remember this');
  });
});
