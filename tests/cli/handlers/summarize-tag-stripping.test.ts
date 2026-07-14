import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realTranscriptParser from '../../../src/shared/transcript-parser.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realTranscriptParserSnapshot = { ...realTranscriptParser };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'MEMSMITH_DATA_DIR') return join(homedir(), '.memsmith');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ MEMSMITH_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ MEMSMITH_EXCLUDED_PROJECTS: '' }),
}));

let mockExtractedMessage: string = '';
let extractCallCount = 0;
mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => {
    extractCallCount += 1;
    return mockExtractedMessage;
  },
}));

// Worker is retired — the summarize handler no longer calls worker-utils.
// Keep the mock so the module resolves, but record any unexpected calls.
const workerCallLog: Array<{ path: string; method: string; body: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCallLog.push({ path: apiPath, method: options?.method ?? 'GET', body: options?.body });
    return Promise.resolve(new Response('{"status":"queued"}', { status: 200 }));
  },
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    return { status: 'queued' };
  },
  isWorkerFallback: (_result: unknown) => false,
  fetchWithTimeout: async (_url: string, _init: RequestInit, _timeout: number) => {
    return new Response('{}', { status: 200 });
  },
}));

// Mock server client used when driving the server path in tag-stripping tests.
// Captures the recordEvent payload so tests can assert on last_assistant_message.
interface RecordedEvent {
  projectId: string;
  eventType: string;
  payload: Record<string, unknown>;
}
let recordedEvents: RecordedEvent[] = [];
let startSessionCallCount = 0;
let endSessionCallCount = 0;

// Build a fresh mock server client for each test that needs the server path.
function makeMockServerClient() {
  return {
    startSession: async (_req: any) => {
      startSessionCallCount += 1;
      return { session: { id: 'mock-server-session-id', projectId: 'test-proj', teamId: '', externalSessionId: null, contentSessionId: null } };
    },
    recordEvent: async (req: any) => {
      recordedEvents.push({ projectId: req.projectId, eventType: req.eventType, payload: req.payload as Record<string, unknown> });
      return { event: { id: 'mock-event-id', projectId: req.projectId, serverSessionId: null } };
    },
    endSession: async (_req: any) => {
      endSessionCallCount += 1;
      return { session: { id: 'mock-server-session-id' } };
    },
  };
}

// Build a mock server RuntimeContext.
function makeServerRuntimeContext() {
  return {
    runtime: 'server' as const,
    client: makeMockServerClient() as any,
    projectId: 'test-proj',
    serverBaseUrl: 'http://mock-server',
  };
}

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  recordedEvents = [];
  startSessionCallCount = 0;
  endSessionCallCount = 0;
  mockExtractedMessage = '';
  extractCallCount = 0;
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/transcript-parser.js', () => realTranscriptParserSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

const baseInput = {
  sessionId: 'sess-tag-strip',
  cwd: '/tmp',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/fake.jsonl',
};

// Worker fallback is retired — the handler skips cleanly (no worker POST).
// Tag-stripping tests now drive the SERVER path so the stripped
// last_assistant_message reaching recordEvent() can be asserted directly.

describe('summarizeHandler — privacy tag stripping', () => {
  it('uses Codex lastAssistantMessage directly without reading a transcript', async () => {
    // Codex platform with stopHookActive=false goes through stripping then
    // the runtime check. Drive server path so we can see the stripped value.
    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      lastAssistantMessage: 'Codex answer <private>SECRET</private>',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(extractCallCount).toBe(0);
    expect(workerCallLog).toHaveLength(0);
    // Tag-stripping must have removed the private block before POSTing.
    const assistantEvent = recordedEvents.find(e => e.eventType === 'assistant_message');
    expect(assistantEvent).toBeDefined();
    expect(String(assistantEvent!.payload.last_assistant_message)).not.toContain('SECRET');
    expect(String(assistantEvent!.payload.last_assistant_message)).toContain('Codex answer');
  });

  it('short-circuits Codex stop hook re-entry', async () => {
    // stopHookActive=true returns early before any runtime call.
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      stopHookActive: true,
      lastAssistantMessage: 'ignored',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(extractCallCount).toBe(0);
    expect(workerCallLog).toHaveLength(0);
  });

  it('strips <private> tags and their content from last_assistant_message', async () => {
    mockExtractedMessage = 'Hello <private>SECRET-VALUE-42</private> world';

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    // The stripped message should reach the server without the secret.
    const assistantEvent = recordedEvents.find(e => e.eventType === 'assistant_message');
    expect(assistantEvent).toBeDefined();
    expect(String(assistantEvent!.payload.last_assistant_message)).not.toContain('SECRET-VALUE-42');
    expect(assistantEvent!.payload.last_assistant_message).toBe('Hello  world');
  });

  it('preserves surrounding content when stripping privacy tags', async () => {
    mockExtractedMessage =
      'Before tag. <private>leak</private> Middle. <private>another</private> After.';

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    const assistantEvent = recordedEvents.find(e => e.eventType === 'assistant_message');
    expect(assistantEvent).toBeDefined();
    const stripped = String(assistantEvent!.payload.last_assistant_message);
    expect(stripped).toContain('Before tag.');
    expect(stripped).toContain('Middle.');
    expect(stripped).toContain('After.');
    expect(stripped).not.toContain('leak');
    expect(stripped).not.toContain('another');
  });

  it('skips the POST when the entire turn is wrapped in a privacy tag', async () => {
    // After stripping, the message is empty → handler returns early without
    // calling server. No recordEvent call is expected.
    mockExtractedMessage = '<private>everything is private</private>';

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    // Handler exits early (empty stripped message) — no server event POSTed.
    expect(recordedEvents).toHaveLength(0);
  });

  it('skips the POST when stripping leaves only whitespace', async () => {
    mockExtractedMessage = '   <private>x</private>\n\t<private>y</private>  ';

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    expect(workerCallLog).toHaveLength(0);
    // Stripped message is whitespace-only → handler returns early, no server call.
    expect(recordedEvents).toHaveLength(0);
  });

  it('does not modify content that contains no privacy tags', async () => {
    mockExtractedMessage = 'Just a normal assistant turn with no privacy markers.';

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    // No tags → message passes through unchanged.
    const assistantEvent = recordedEvents.find(e => e.eventType === 'assistant_message');
    expect(assistantEvent).toBeDefined();
    expect(assistantEvent!.payload.last_assistant_message).toBe(
      'Just a normal assistant turn with no privacy markers.',
    );
  });

  const taggedPayloads: Array<[string, string]> = [
    ['<private>', '<private>SECRET-PRIVATE</private>'],
    ['<memsmith-context>', '<memsmith-context>SECRET-CTX</memsmith-context>'],
    ['<system-instruction>', '<system-instruction>SECRET-SI-DASH</system-instruction>'],
    ['<system_instruction>', '<system_instruction>SECRET-SI-UNDER</system_instruction>'],
    ['<persisted-output>', '<persisted-output>SECRET-PO</persisted-output>'],
  ];

  for (const [label, payload] of taggedPayloads) {
    it(`strips ${label} tags from last_assistant_message`, async () => {
      const secret = payload.match(/SECRET-[A-Z-]+/)![0];
      mockExtractedMessage = `before ${payload} after`;

      mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
        ...realRuntimeSelectorSnapshot,
        resolveRuntimeContext: () => makeServerRuntimeContext(),
        logServerFallback: () => {},
      }));

      const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
      const result = await summarizeHandler.execute(baseInput as any);

      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(workerCallLog).toHaveLength(0);
      // The secret must NOT appear in what was POSTed to the server.
      const assistantEvent = recordedEvents.find(e => e.eventType === 'assistant_message');
      expect(assistantEvent).toBeDefined();
      expect(String(assistantEvent!.payload.last_assistant_message)).not.toContain(secret);
    });
  }
});

// Migrated from the now-deleted Gemini CLI host-integration compat test file
// (Phase A removal) — these two checks are unrelated to that integration, they
// just happened to live in the same file. Preserved here so the platformSource
// plumbing in summarize.ts keeps regression coverage.
describe('Summarize handler - platformSource in request body', () => {
  it('should include platformSource import in summarize.ts', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    expect(src).toContain('normalizePlatformSource');
    expect(src).toContain('platform-source');
  });

  it('summarize.ts still computes platformSource (worker path retired, server path unchanged)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    // platformSource is still passed to summarizeViaServer — verify it is computed.
    expect(src).toContain('platformSource');
    expect(src).toContain('normalizePlatformSource');
    // Worker endpoint is gone — this string must no longer appear.
    expect(src).not.toContain('/api/sessions/summarize');
  });
});
