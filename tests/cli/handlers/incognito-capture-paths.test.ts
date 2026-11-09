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

  it('session-init still delivers events spooled before incognito, but starts no session or prompt capture', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const spool = await import('../../../src/cli/handlers/capture-spool.js');
    const path = spool.defaultSpoolPath();
    mkdirSync(require('node:path').dirname(path), { recursive: true });
    rmSync(path, { force: true });
    writeFileSync(path, `${JSON.stringify({ contentSessionId: SESSION, eventType: 'tool_use' })}\n`);

    setIncognito(SESSION, true);
    await sessionInitHandler.execute({ sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'hello' });
    expect(calls).toEqual(['recordEvent']);
    expect(spool.readSpooledEvents(path)).toEqual([]);
  });

  it('session-init still claims a pending team join and shows the project notice while incognito', async () => {
    const claimed: string[] = [];
    setSessionInitDependenciesForTesting({
      resolveRuntimeContext: () => serverRuntime as never,
      shouldTrackProject: () => true,
      logServerFallback: () => {},
      mintProjectIdentity: async () => null as never,
      projectNotice: async () => 'project notice',
      claimPendingJoin: async (cwd: string) => { claimed.push(cwd); return undefined as never; },
    });
    setIncognito(SESSION, true);
    const res = await sessionInitHandler.execute({ sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'hello' });
    expect(claimed).toEqual(['/tmp/incog-paths']);
    expect(res.hookSpecificOutput?.additionalContext).toContain('project notice');
    expect(calls).not.toContain('startSession');
  });

  it('prompt-injection: saves a memory gap normally, nothing when incognito', async () => {
    const added: string[] = [];
    const base = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ms-incog-pi-'));
    const rt = {
      runtime: 'server' as const, projectId: 'p1', serverBaseUrl: 'http://fake',
      client: {
        contextObservations: async () => ({ observations: [], context: '' }),
        addObservation: async (i: { content: string }) => { added.push(i.content); return {}; },
      },
    };
    const { createPromptInjectionHandler } = await import('../../../src/cli/handlers/prompt-injection.js');
    const handler = createPromptInjectionHandler({
      loadSettings: () => ({ MEMSMITH_SEMANTIC_INJECT: 'true', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }),
      resolveRuntime: () => rt as never,
      sessionBaseDir: base,
    });
    const input = { sessionId: SESSION, cwd: '/tmp', prompt: 'why did we switch the queue engine to inline?' } as never;
    await handler.execute(input);
    expect(added).toHaveLength(1);

    added.length = 0;
    setIncognito(SESSION, true);
    await handler.execute(input);
    expect(added).toEqual([]);
  });

  it('the incognito-on reply and the heartbeat tell the agent which memory writes to avoid', async () => {
    const { handleIncognitoCommand } = await import('../../../src/cli/handlers/incognito-command.js');
    const { incognitoHeartbeat } = await import('../../../src/cli/handlers/session-init.js');
    const on = handleIncognitoCommand(SESSION, 'on').message;
    const beat = incognitoHeartbeat(SESSION, { MEMSMITH_INCOGNITO_REMINDER_TURNS: '1' } as never) ?? '';
    for (const text of [on, beat]) {
      expect(text).toContain('observation_add');
      expect(text).toContain('observation_record_event');
      expect(text).toContain('note_add');
      expect(text).toContain('explicitly asks');
    }
  });

  it('the heartbeat reaches the agent even when session-init does its other work', async () => {
    setIncognito(SESSION, true);
    const res = await sessionInitHandler.execute({ sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'hi' });
    expect(res.hookSpecificOutput?.additionalContext ?? '').not.toContain('observation_add');
    process.env.MEMSMITH_INCOGNITO_REMINDER_TURNS = '1';
    try {
      const beat = await sessionInitHandler.execute({ sessionId: SESSION, cwd: '/tmp/incog-paths', platform: 'claude-code', prompt: 'hi' });
      expect(beat.hookSpecificOutput?.additionalContext).toContain('observation_record_event');
    } finally {
      delete process.env.MEMSMITH_INCOGNITO_REMINDER_TURNS;
    }
  });
});
