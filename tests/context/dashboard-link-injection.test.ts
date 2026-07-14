// SPDX-License-Identifier: Apache-2.0
//
// Tests that the dashboard URL line is prepended to the SessionStart injection
// both when memory is non-empty and when it is empty (new/blank project).

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  contextHandler,
  setContextDependenciesForTesting,
} from '../../src/cli/handlers/context.js';
import { resolveDashboardUrl } from '../../src/shared/dashboard-url.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  setContextDependenciesForTesting({});
  loggerSpies.forEach(spy => spy.mockRestore());
});

function installDeps(primaryInjection: string) {
  setContextDependenciesForTesting({
    loadFromFileOnce: () => ({} as any),
    getProjectContext: () => ({
      primary: 'test-project',
      parent: null,
      isWorktree: false,
      allProjects: ['test-project'],
    }),
    resolveRuntimeContext: () => ({
      runtime: 'server',
      projectId: 'test-project',
      serverBaseUrl: 'http://server.test',
      client: {
        searchObservations: async () => ({
          observations: primaryInjection
            ? [{ id: 'obs-1', projectId: 'test-project', content: primaryInjection, metadata: {} }]
            : [],
        }),
      },
    }),
  });
}

describe('dashboard link in SessionStart injection', () => {
  it('prepends the dashboard line when memory is non-empty', async () => {
    const memoryContent = '## Relevant team memory\n- something important';
    installDeps(memoryContent);

    const result = await contextHandler.execute({
      sessionId: 'session-dash-nonempty',
      cwd: '/tmp/x',
      platform: 'claude-code',
    });

    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
    expect(ctx).toContain(resolveDashboardUrl());
    expect(ctx).toContain('something important'); // memory still present
    // Dashboard line must come first
    expect(ctx.indexOf('📊 MemSmith dashboard:')).toBeLessThan(ctx.indexOf('something important'));
  });

  it('still shows the dashboard line when memory is empty', async () => {
    installDeps('');

    const result = await contextHandler.execute({
      sessionId: 'session-dash-empty',
      cwd: '/tmp/x',
      platform: 'claude-code',
    });

    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
    expect(ctx).toContain(resolveDashboardUrl());
  });
});
