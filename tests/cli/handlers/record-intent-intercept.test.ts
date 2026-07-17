// tests/cli/handlers/record-intent-intercept.test.ts
import { describe, it, expect } from 'bun:test';
import { recordIntentInterceptHandler } from '../../../src/cli/handlers/record-intent-intercept';
import { RecordArmedStore } from '../../../src/services/retrieval/record-armed-store';

function armSession(sessionId: string, armed: boolean) {
  new RecordArmedStore(sessionId).write({ armed, promptId: null, ts: 1 });
}

describe('recordIntentInterceptHandler', () => {
  it('rewrites observation_add to user_note when armed', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-a`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'a note', metadata: { topic: 'x' } },
    } as any);
    const updated = res.hookSpecificOutput?.updatedInput as any;
    expect(updated.kind).toBe('user_note');
    expect(updated.metadata).toEqual({ topic: 'x', userDirected: true });
    expect(updated.content).toBe('a note');
  });
  it('does nothing when not armed', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-b`;
    armSession(sessionId, false);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'x' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(res.continue).toBe(true);
  });
  it('does nothing when no stash exists', async () => {
    const res = await recordIntentInterceptHandler.execute({
      sessionId: `int-none-${process.pid}-${Math.trunc(performance.now())}`, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'x' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
  it('does nothing when content is blank', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-c`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: '   ' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
  it('never denies', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-d`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'a note' },
    } as any);
    expect(res.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});
