import { describe, it, expect } from 'bun:test';
import { promptInjectionHandler } from '../../../src/cli/handlers/prompt-injection.js';

// Minimal fake: the handler reads runtime + settings via injected deps hook.
// We exercise the pure result-shaping by pointing at a non-server runtime
// (fail-open path) — asserting it never throws and returns a continue result.
describe('promptInjectionHandler', () => {
  it('returns a continue result and never throws when no runtime', async () => {
    const res = await promptInjectionHandler.execute({
      sessionId: 's1', cwd: '/tmp', prompt: 'why did we choose X?',
    } as any);
    expect(res.continue).toBe(true);
    // additionalContext may be absent/empty when nothing to inject
    if (res.hookSpecificOutput) {
      expect(res.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    }
  });

  it('empty prompt → clean skip', async () => {
    const res = await promptInjectionHandler.execute({ sessionId: 's1', cwd: '/tmp', prompt: '' } as any);
    expect(res.continue).toBe(true);
  });
});
