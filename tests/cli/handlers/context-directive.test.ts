import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE } from '../../../src/services/retrieval/directive.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';

describe('SessionStart directive', () => {
  it('SessionStart context includes the memory-first directive', async () => {
    const res = await contextHandler.execute({ sessionId: 's1', cwd: '/tmp', platform: 'claude-code' } as any);
    const ctx = res.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain(MEMORY_FIRST_DIRECTIVE.split('\n')[0]);
  });
});
