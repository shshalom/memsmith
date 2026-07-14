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
      MEMSMITH_SEMANTIC_INJECT_LIMIT: '5',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    MEMSMITH_EXCLUDED_PROJECTS: '',
    MEMSMITH_RUNTIME: 'local',
    MEMSMITH_SEMANTIC_INJECT: 'true',
    MEMSMITH_SEMANTIC_INJECT_LIMIT: '5',
  }),
}));

// Worker is retired — keep the mock so the module resolves cleanly, but
// record any unexpected calls so tests can assert the worker is NOT called.
mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, _method: string, _body: unknown) => {
    throw new Error(`worker is retired — unexpected call to ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  delete process.env.MEMSMITH_INTERNAL;
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
// the handler skips cleanly — no worker call, no session init, no semantic injection.
// These tests verify the clean-skip path for each scenario that previously exercised
// the worker path.

describe('sessionInitHandler per-prompt hybrid injection', () => {
  it('1: local runtime -> handler skips cleanly without calling worker or team server', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'How do I implement the hybrid RRF injection pipeline?';
    const script = `
      let fetchTeamMemoryCalled = false;
      let workerCalled = false;
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-1',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
      if (result.hookSpecificOutput) throw new Error('expected no hookSpecificOutput on local skip: ' + JSON.stringify(result.hookSpecificOutput));
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

  it('2: local runtime -> skips cleanly (no worker semantic call)', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'What is the current state of the per-prompt injection feature?';
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-2',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
      if (result.hookSpecificOutput) throw new Error('expected no additionalContext on local skip: ' + JSON.stringify(result));
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

  it('3: local runtime -> skips cleanly (no fallback to worker)', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'Server returns empty rows so we should fall through to worker semantic.';
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-3',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
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

  it('4: local runtime -> skips cleanly without team server query', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'Explicit query assertion: this exact text must be passed as query.';
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-4',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
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

  it('5: injectability gate: short prompt still skips cleanly on local runtime', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'Short prompt';  // 12 chars — below the old 20-char gate (gate removed with worker)
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-5',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
      if (result.hookSpecificOutput?.additionalContext) {
        throw new Error('additionalContext should be absent, got: ' + JSON.stringify(result.hookSpecificOutput.additionalContext));
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

  it('6: local runtime -> handler returns { continue: true } and does not throw', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'This prompt triggers the local skip path.';
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      let result;
      try {
        result = await sessionInitHandler.execute({
          sessionId: 'session-hybrid-6',
          cwd: '/tmp/session-hybrid-test',
          platform: 'claude-code',
          prompt: ${JSON.stringify(prompt)},
        });
      } catch (e) {
        throw new Error('handler should not throw on local skip, but got: ' + e.message);
      }
      if (!result || !result.continue) throw new Error('handler must return { continue: true } on local skip: ' + JSON.stringify(result));
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

  it('7: local runtime -> skips cleanly regardless of MEMSMITH_TEAM_INJECT setting', async () => {
    const env = { ...process.env };
    delete env.MEMSMITH_INTERNAL;
    const prompt = 'This prompt has URL and key set but the master TEAM_INJECT switch is off.';
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        resolveRuntimeContext: () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
        shouldTrackProject: () => true,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-7',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue || !result.suppressOutput) throw new Error('expected clean skip: ' + JSON.stringify(result));
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
