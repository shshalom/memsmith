// SPDX-License-Identifier: Apache-2.0
//
// An incognito session must produce no capture request from any hook. Each
// case runs the same input twice: once normally, to prove the fake runtime
// observes the capture, and once incognito, to prove the capture is gone.
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realSnapshot = { ...realRuntimeSelector };

const calls: string[] = [];
const client = {
  startSession: async () => { calls.push('startSession'); return { session: { id: 'srv-1' } }; },
  recordEvent: async () => { calls.push('recordEvent'); },
  endSession: async () => { calls.push('endSession'); },
  recordIntent: async () => { calls.push('recordIntent'); },
};
const serverRuntime = { runtime: 'server' as const, projectId: 'p1', serverBaseUrl: 'http://127.0.0.1:1', client };

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realSnapshot,
  resolveRuntimeContext: () => serverRuntime,
}));

afterAll(() => {
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realSnapshot);
});

const { setIncognito, resetSession } = await import('../../../src/cli/incognito.js');
const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('../../../src/cli/handlers/session-init.js');
const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');
const { createRecordIntentHandler } = await import('../../../src/cli/handlers/record-intent.js');
const { flushSpooledEvents } = await import('../../../src/cli/handlers/spool-flush.js');
const { captureSuppressed } = await import('../../../src/cli/incognito.js');

const SESSION = 'incognito-capture-paths';

function useSessionInitDeps() {
  setSessionInitDependenciesForTesting({
    resolveRuntimeContext: () => serverRuntime as never,
    shouldTrackProject: () => true,
    logServerFallback: () => {},
    mintProjectIdentity: async () => null as never,
    projectNotice: async () => null,
    claimPendingJoin: async () => undefined as never,
  });
}

describe('incognito suppresses every capture path', () => {
  beforeEach(() => {
    calls.length = 0;
    resetSession(SESSION);
    useSessionInitDeps();
  });

  it('session-init: records the prompt normally, nothing when incognito', async () => {
    const input = { sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'refactor the parser' };
    await sessionInitHandler.execute(input);
    expect(calls).toContain('startSession');

    calls.length = 0;
    setIncognito(SESSION, true);
    await sessionInitHandler.execute(input);
    expect(calls).toEqual([]);
  });

  it('summarize (Stop): records the summary normally, nothing when incognito', async () => {
    const input = { sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', lastAssistantMessage: 'Done refactoring.' };
    await summarizeHandler.execute(input);
    expect(calls).toContain('endSession');

    calls.length = 0;
    setIncognito(SESSION, true);
    await summarizeHandler.execute(input);
    expect(calls).toEqual([]);
  });

  it('file-edit: records the edit normally, nothing when incognito', async () => {
    const input = { sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', filePath: '/tmp/incog-paths/a.ts' };
    await fileEditHandler.execute(input);
    expect(calls).toContain('recordEvent');

    calls.length = 0;
    setIncognito(SESSION, true);
    await fileEditHandler.execute(input);
    expect(calls).toEqual([]);
  });

  it('record-intent backstop: writes the note normally, nothing when incognito, and never arms the interceptor', async () => {
    const armedWrites: boolean[] = [];
    const handler = createRecordIntentHandler({
      loadSettings: () => ({ MEMSMITH_RECORD_INTENT_BACKSTOP: 'true' }),
      resolveRuntime: () => serverRuntime as never,
      armedStore: () => ({ write: (rec: { armed: boolean }) => { armedWrites.push(rec.armed); } }),
    });
    const input = { sessionId: SESSION, cwd: '/tmp/incog-paths', prompt: 'remember that the dashboard runs on 38879' } as never;
    await handler.execute(input);
    expect(calls).toContain('recordIntent');

    calls.length = 0;
    armedWrites.length = 0;
    setIncognito(SESSION, true);
    const res = await handler.execute(input);
    expect(calls).toEqual([]);
    expect(armedWrites).toEqual([false]);
    expect(res.systemMessage).toBeUndefined();
  });

  it('spool flush: drops events from an incognito session and delivers the rest', async () => {
    setIncognito(SESSION, true);
    const sent: unknown[] = [];
    let cleared = false;
    const result = await flushSpooledEvents({
      read: () => [{ contentSessionId: SESSION, id: 'private' }, { contentSessionId: 'other-session', id: 'public' }],
      send: async (e) => { sent.push(e); },
      clear: () => { cleared = true; },
      skip: (e) => captureSuppressed((e as { contentSessionId?: string }).contentSessionId),
    });
    expect(sent).toEqual([{ contentSessionId: 'other-session', id: 'public', projectId: null }]);
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(cleared).toBe(true);
  });

  it('session-init leaves the spool untouched while incognito', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const spool = await import('../../../src/cli/handlers/capture-spool.js');
    const path = spool.defaultSpoolPath();
    mkdirSync(require('node:path').dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ contentSessionId: SESSION, eventType: 'tool_use' })}\n`);

    setIncognito(SESSION, true);
    await sessionInitHandler.execute({ sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'hello' });
    expect(calls).toEqual([]);

    expect(spool.readSpooledEvents(path)).toHaveLength(1);
  });
});
