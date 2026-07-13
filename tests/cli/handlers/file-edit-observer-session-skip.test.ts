import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

const dataDir = join(tmpdir(), 'memsmith-file-edit-observer-test');
// Worker retirement — file-edit now records via the runtime-selector +
// ServerClient path (POST /v1/events) instead of executeWithWorkerFallback.
// For an internal observer session the handler must clean-skip BEFORE resolving
// the runtime, so recordEvent must never fire.
const recordEventLog: Array<Record<string, unknown>> = [];

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'MEMSMITH_DATA_DIR') return dataDir;
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ MEMSMITH_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ MEMSMITH_EXCLUDED_PROJECTS: '' }),
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server',
    projectId: 'observer-project',
    serverBaseUrl: 'http://127.0.0.1:1',
    client: {
      recordEvent: async (event: Record<string, unknown>) => {
        recordEventLog.push(event);
        throw new Error('recordEvent must not be called for internal observer sessions');
      },
    },
  }),
  logServerFallback: () => {},
}));

import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  recordEventLog.length = 0;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('fileEditHandler internal observer sessions', () => {
  it('skips file edit observations before resolving the runtime', async () => {
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute({
      sessionId: 'observer-session-file-edit',
      cwd: OBSERVER_SESSIONS_DIR,
      platform: 'claude-code',
      filePath: join(OBSERVER_SESSIONS_DIR, 'transcript.jsonl'),
      edits: [{ oldText: 'before', newText: 'after' }],
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(recordEventLog).toEqual([]);
  });
});
