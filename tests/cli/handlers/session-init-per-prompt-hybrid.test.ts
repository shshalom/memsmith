import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_SEMANTIC_INJECT: 'true',
      CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_SEMANTIC_INJECT: 'true',
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, _method: string, _body: unknown) => {
    if (apiPath === '/api/sessions/init') {
      return { sessionDbId: 42, promptNumber: 1 };
    }
    if (apiPath === '/api/context/semantic') {
      return { context: 'worker semantic context', count: 1 };
    }
    throw new Error(`Unexpected worker call: ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  delete process.env.CLAUDE_MEM_INTERNAL;
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
    delete process.env.CLAUDE_MEM_INTERNAL;
  } else {
    process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('sessionInitHandler per-prompt hybrid injection', () => {
  it('1: server-configured -> fetchTeamMemory called with query===prompt; worker NOT called for semantic', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'How do I implement the hybrid RRF injection pipeline?';
    const script = `
      const fetchTeamMemoryCalls = [];
      let buildInjectionBlockCalled = false;
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_TEAM_SERVER_URL: 'http://team.test',
          CLAUDE_MEM_TEAM_API_KEY: 'test-key',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async (input) => {
          fetchTeamMemoryCalls.push(input);
          return [{ id: '1', content: 'team memory item', metadata: {} }];
        },
        buildInjectionBlock: async (deps, input) => {
          buildInjectionBlockCalled = true;
          const rows = await deps.hybridSearch(input);
          return rows.length > 0 ? '## Relevant team memory (review before acting)\\n- team memory item' : '';
        },
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          throw new Error('worker semantic should NOT be called when server returns content: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-1',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue) throw new Error('result.continue must be true: ' + JSON.stringify(result));
      if (fetchTeamMemoryCalls.length !== 1) throw new Error('fetchTeamMemory call count: ' + fetchTeamMemoryCalls.length);
      if (!buildInjectionBlockCalled) throw new Error('buildInjectionBlock was not called');
      const semanticWorkerCalls = workerCallLog.filter(c => c.path === '/api/context/semantic');
      if (semanticWorkerCalls.length !== 0) throw new Error('worker semantic was called unexpectedly: ' + JSON.stringify(semanticWorkerCalls));
      if (!result.hookSpecificOutput?.additionalContext) throw new Error('additionalContext missing: ' + JSON.stringify(result));
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

  it('2: server NOT configured -> fetchTeamMemory NOT called; worker semantic path used (regression guard)', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'What is the current state of the per-prompt injection feature?';
    const script = `
      let fetchTeamMemoryCalled = false;
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          // No CLAUDE_MEM_TEAM_SERVER_URL or CLAUDE_MEM_TEAM_API_KEY
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async () => {
          fetchTeamMemoryCalled = true;
          return [];
        },
        buildInjectionBlock: async () => {
          throw new Error('buildInjectionBlock should not be called when no server configured');
        },
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'worker semantic context', count: 1 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-2',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue) throw new Error('result.continue must be true: ' + JSON.stringify(result));
      if (fetchTeamMemoryCalled) throw new Error('fetchTeamMemory should NOT have been called');
      const semanticWorkerCalls = workerCallLog.filter(c => c.path === '/api/context/semantic');
      if (semanticWorkerCalls.length !== 1) throw new Error('worker semantic should have been called once, got: ' + semanticWorkerCalls.length);
      if (result.hookSpecificOutput?.additionalContext !== 'worker semantic context') {
        throw new Error('expected worker semantic context, got: ' + JSON.stringify(result.hookSpecificOutput?.additionalContext));
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

  it('3: server configured but fetchTeamMemory returns [] -> falls through to worker path', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Server returns empty rows so we should fall through to worker semantic.';
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_TEAM_SERVER_URL: 'http://team.test',
          CLAUDE_MEM_TEAM_API_KEY: 'test-key',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async () => [],
        buildInjectionBlock: async () => '',
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'worker fallback context', count: 2 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-3',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue) throw new Error('result.continue must be true: ' + JSON.stringify(result));
      const semanticWorkerCalls = workerCallLog.filter(c => c.path === '/api/context/semantic');
      if (semanticWorkerCalls.length !== 1) throw new Error('worker semantic should be called once after empty server result, got: ' + semanticWorkerCalls.length);
      if (result.hookSpecificOutput?.additionalContext !== 'worker fallback context') {
        throw new Error('expected worker fallback context, got: ' + JSON.stringify(result.hookSpecificOutput?.additionalContext));
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

  it('4: server-mode query is the prompt text (explicit assert on query arg)', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Explicit query assertion: this exact text must be passed as query.';
    const script = `
      let capturedQuery = null;
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_TEAM_SERVER_URL: 'http://team.test',
          CLAUDE_MEM_TEAM_API_KEY: 'test-key',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async (input) => {
          capturedQuery = input.query;
          return [{ id: '1', content: 'context content', metadata: {} }];
        },
        buildInjectionBlock: async (deps, input) => {
          const rows = await deps.hybridSearch(input);
          return rows.length > 0 ? '## Relevant team memory (review before acting)\\n- context content' : '';
        },
        executeWithWorkerFallback: async (apiPath, method, body) => {
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          throw new Error('worker semantic should not be called: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-4',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (capturedQuery !== ${JSON.stringify(prompt)}) {
        throw new Error('query mismatch — expected the prompt text, got: ' + JSON.stringify(capturedQuery));
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

  it('5: injectability gate: a <20-char prompt injects nothing on either path', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Short prompt';  // 12 chars — below the 20-char gate
    const script = `
      let fetchTeamMemoryCalled = false;
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_TEAM_SERVER_URL: 'http://team.test',
          CLAUDE_MEM_TEAM_API_KEY: 'test-key',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async () => {
          fetchTeamMemoryCalled = true;
          return [];
        },
        buildInjectionBlock: async () => 'should not be called',
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'semantic context', count: 1 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-hybrid-5',
        cwd: '/tmp/session-hybrid-test',
        platform: 'claude-code',
        prompt: ${JSON.stringify(prompt)},
      });
      if (!result.continue) throw new Error('result.continue must be true: ' + JSON.stringify(result));
      if (fetchTeamMemoryCalled) throw new Error('fetchTeamMemory should not be called for short prompts');
      const semanticWorkerCalls = workerCallLog.filter(c => c.path === '/api/context/semantic');
      if (semanticWorkerCalls.length !== 0) throw new Error('worker semantic should NOT be called for short prompts, got: ' + semanticWorkerCalls.length);
      if (result.hookSpecificOutput?.additionalContext) {
        throw new Error('additionalContext should be absent for short prompts, got: ' + JSON.stringify(result.hookSpecificOutput.additionalContext));
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

  it('6: server branch throws -> caught; handler returns valid { continue: true } result', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'This prompt triggers the server branch which will throw an error.';
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
          CLAUDE_MEM_TEAM_SERVER_URL: 'http://team.test',
          CLAUDE_MEM_TEAM_API_KEY: 'test-key',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        fetchTeamMemory: async () => {
          throw new Error('simulated network failure');
        },
        buildInjectionBlock: async () => { throw new Error('should not reach buildInjectionBlock'); },
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'worker fallback after error', count: 1 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
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
        throw new Error('handler should not throw, but got: ' + e.message);
      }
      if (!result || !result.continue) throw new Error('handler must return { continue: true } even on server error: ' + JSON.stringify(result));
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
