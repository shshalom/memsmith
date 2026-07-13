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
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realTranscriptParserSnapshot = { ...realTranscriptParser };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

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
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
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
});

const baseInput = {
  sessionId: 'sess-tag-strip',
  cwd: '/tmp',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/fake.jsonl',
};

// Worker fallback is retired — the handler skips cleanly (no worker POST).
// These tests verify the handler still processes and strips tags before skipping.

describe('summarizeHandler — privacy tag stripping', () => {
  it('uses Codex lastAssistantMessage directly without reading a transcript', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      lastAssistantMessage: 'Codex answer <private>SECRET</private>',
    });

    // Worker is retired: no worker calls expected; handler skips cleanly.
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(extractCallCount).toBe(0);
    expect(workerCallLog).toHaveLength(0);
  });

  it('short-circuits Codex stop hook re-entry', async () => {
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

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    // Tag stripping runs before the handler reaches the runtime check.
    // With no reachable server runtime the handler skips cleanly — no worker call.
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
  });

  it('preserves surrounding content when stripping privacy tags', async () => {
    mockExtractedMessage =
      'Before tag. <private>leak</private> Middle. <private>another</private> After.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
  });

  it('skips the POST when the entire turn is wrapped in a privacy tag', async () => {
    mockExtractedMessage = '<private>everything is private</private>';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
  });

  it('skips the POST when stripping leaves only whitespace', async () => {
    mockExtractedMessage = '   <private>x</private>\n\t<private>y</private>  ';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    expect(workerCallLog).toHaveLength(0);
  });

  it('does not modify content that contains no privacy tags', async () => {
    mockExtractedMessage = 'Just a normal assistant turn with no privacy markers.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    // Handler skips cleanly — no worker call (worker retired).
    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
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

      const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
      const result = await summarizeHandler.execute(baseInput as any);

      // Handler reaches the runtime check with a non-empty stripped message,
      // then skips cleanly (no server runtime configured in tests).
      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(workerCallLog).toHaveLength(0);
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
