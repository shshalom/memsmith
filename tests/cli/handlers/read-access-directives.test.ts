import { afterEach, describe, expect, it } from 'bun:test';
import { agentDirectiveHandler } from '../../../src/cli/handlers/agent-directive.js';
import { createRecordIntentHandler } from '../../../src/cli/handlers/record-intent.js';
import { MEMORY_FIRST_DIRECTIVE, RECORD_INTENT_DIRECTIVE } from '../../../src/services/retrieval/directive.js';
import { resetFeatureSwitchesForTesting } from '../../../src/shared/feature-switches.js';

const saved = { access: process.env.MEMSMITH_ACCESS, disabled: process.env.MEMSMITH_HOOKS_DISABLED };

function setEnv(access?: string, disabled?: string) {
  if (access === undefined) delete process.env.MEMSMITH_ACCESS; else process.env.MEMSMITH_ACCESS = access;
  if (disabled === undefined) delete process.env.MEMSMITH_HOOKS_DISABLED; else process.env.MEMSMITH_HOOKS_DISABLED = disabled;
  resetFeatureSwitchesForTesting();
}

afterEach(() => setEnv(saved.access, saved.disabled));

const RECORD_INTENT_HEAD = RECORD_INTENT_DIRECTIVE.split('\n')[0];

describe('subagent directive under read access', () => {
  it('tells a subagent of a writing session to record notes with note_add', async () => {
    setEnv();
    const res = await agentDirectiveHandler.execute({ sessionId: 's', cwd: '/tmp', toolName: 'Task' } as never);
    expect(res.hookSpecificOutput?.additionalContext).toContain(RECORD_INTENT_HEAD);
  });

  it('keeps memory-first but drops the note_add instruction in a read-only session', async () => {
    setEnv('read');
    const ctx = (await agentDirectiveHandler.execute({ sessionId: 's', cwd: '/tmp', toolName: 'Task' } as never)).hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain(MEMORY_FIRST_DIRECTIVE.split('\n')[0]);
    expect(ctx).not.toContain(RECORD_INTENT_HEAD);
    expect(ctx).toContain('MEMSMITH_ACCESS=read');
  });
});

describe('record-intent armed flag on early returns', () => {
  function handler(writes: Array<{ armed: boolean }>) {
    return createRecordIntentHandler({
      loadSettings: () => ({ MEMSMITH_RECORD_INTENT_BACKSTOP: 'false' }),
      resolveRuntime: () => ({ runtime: 'local', reason: 'server_context_unavailable' }) as never,
      armedStore: () => ({ write: (rec: { armed: boolean }) => { writes.push(rec); } }) as never,
    });
  }

  for (const [label, access, disabled] of [['read access', 'read', undefined], ['record-intent turned off', undefined, 'record-intent']] as const) {
    it(`clears a stale armed flag when ${label} returns early`, async () => {
      setEnv(access, disabled);
      const writes: Array<{ armed: boolean }> = [];
      await handler(writes).execute({ sessionId: 's', cwd: '/tmp', prompt: 'remember that the queue is inline' } as never);
      expect(writes.map((w) => w.armed)).toEqual([false]);
    });
  }
});
