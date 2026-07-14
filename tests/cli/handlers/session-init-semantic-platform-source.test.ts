import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const originalInternalEnv = process.env.MEMSMITH_INTERNAL;

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'MEMSMITH_DATA_DIR') return join(homedir(), '.memsmith');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({
      MEMSMITH_EXCLUDED_PROJECTS: '',
      MEMSMITH_RUNTIME: 'local',
      MEMSMITH_SEMANTIC_INJECT: 'true',
      MEMSMITH_SEMANTIC_INJECT_LIMIT: '7',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    MEMSMITH_EXCLUDED_PROJECTS: '',
    MEMSMITH_RUNTIME: 'local',
    MEMSMITH_SEMANTIC_INJECT: 'true',
    MEMSMITH_SEMANTIC_INJECT_LIMIT: '7',
  }),
}));

// Worker is retired — record any unexpected calls.
const workerCallLog: Array<{ path: string; method: string; body: unknown }> = [];

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    throw new Error(`worker is retired — unexpected call to ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  delete process.env.MEMSMITH_INTERNAL;
  workerCallLog.length = 0;
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  if (originalInternalEnv === undefined) {
    delete process.env.MEMSMITH_INTERNAL;
  } else {
    process.env.MEMSMITH_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

// Worker fallback is retired. When resolveRuntimeContext() returns { runtime: 'local' }
// the handler skips cleanly without calling the worker semantic endpoint.
// This test verifies the clean-skip on the local path (platform-source plumbing
// is exercised in the server path, which is tested in session-init-server-beta-context.test.ts).

describe('sessionInitHandler semantic injection platform source', () => {
  it('skips cleanly on local runtime — no worker semantic call, no additionalContext', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'Please restore the platform-specific context for semantic injection.';
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-semantic-platform',
        cwd: '/tmp/session-init-semantic-platform-test',
        platform: 'codex-cli',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
      if (workerCallLog.length !== 0) throw new Error('worker must not be called: ' + JSON.stringify(workerCallLog));
      if (result.hookSpecificOutput?.additionalContext) {
        throw new Error('expected no additionalContext on local skip, got: ' + JSON.stringify(result.hookSpecificOutput.additionalContext));
      }
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(new TextDecoder().decode(result.stdout)).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
