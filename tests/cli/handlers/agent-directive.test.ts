import { describe, it, expect } from 'bun:test';
import { agentDirectiveHandler } from '../../../src/cli/handlers/agent-directive.js';
import { MEMORY_FIRST_DIRECTIVE } from '../../../src/services/retrieval/directive.js';

describe('agentDirectiveHandler', () => {
  it('injects the memory-first directive on a Task/Agent spawn', async () => {
    const res = await agentDirectiveHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Task', toolInput: { prompt: 'do a thing' } } as any);
    expect(res.hookSpecificOutput?.additionalContext).toContain(MEMORY_FIRST_DIRECTIVE.split('\n')[0]);
    expect(res.hookSpecificOutput?.permissionDecision).toBe('allow'); // never blocks a spawn
  });
});
