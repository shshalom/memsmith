// SPDX-License-Identifier: Apache-2.0
//
// Regression coverage for the worker-runtime retirement (branch
// embedded-pg-local-runtime). The retirement deleted the worker route
// `/api/context/inject` that served SessionStart / UserPromptSubmit primary
// memory injection, but left the context handler pointed at it — so injection
// silently returned EMPTY on the local/server runtime even when observations
// existed. This test PROVES the handler now retrieves real recent context via
// the server runtime (empty-query "list recent") and injects a NON-EMPTY string
// containing the seeded observation content. It is the coverage gap that let the
// regression through: it must FAIL against the broken worker-pointed code and
// PASS after the repoint.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  contextHandler,
  setContextDependenciesForTesting,
} from '../../../src/cli/handlers/context.js';
import { logger } from '../../../src/utils/logger.js';
import { resolveDashboardUrl } from '../../../src/shared/dashboard-url.js';

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

describe('contextHandler SessionStart injection (local/server runtime)', () => {
  it('injects real recent context when observations exist for the project', async () => {
    const searchCalls: unknown[] = [];
    const seededContent = 'SEEDED: fixed the embedded-pg boot race in local-runtime-cli';

    setContextDependenciesForTesting({
      loadFromFileOnce: () => ({}),
      getProjectContext: () => ({
        primary: 'memsmith',
        parent: null,
        isWorktree: false,
        allProjects: ['memsmith'],
      }),
      resolveRuntimeContext: () => ({
        runtime: 'server',
        projectId: 'memsmith',
        serverBaseUrl: 'http://server.test',
        client: {
          searchObservations: async (input: unknown) => {
            searchCalls.push(input);
            return {
              observations: [
                { id: 'obs-1', projectId: 'memsmith', content: seededContent, metadata: {} },
                { id: 'obs-2', projectId: 'memsmith', content: 'SEEDED: second recent observation', metadata: {} },
              ],
            };
          },
        },
      }),
    });

    const result = await contextHandler.execute({
      sessionId: 'session-injection',
      cwd: '/tmp/memsmith',
      platform: 'claude-code',
    });

    const injected = result.hookSpecificOutput?.additionalContext ?? '';
    // The whole point: non-empty and contains the seeded content.
    expect(injected.length).toBeGreaterThan(0);
    expect(injected).toContain(seededContent);
    // Injection is NOT query-driven at SessionStart — recent mode (empty query).
    expect(searchCalls).toHaveLength(1);
    expect((searchCalls[0] as { query: string }).query).toBe('');
    expect((searchCalls[0] as { projectId: string }).projectId).toBe('memsmith');
  });

  it('injects empty (never throws) when no observations exist', async () => {
    setContextDependenciesForTesting({
      loadFromFileOnce: () => ({}),
      getProjectContext: () => ({
        primary: 'memsmith',
        parent: null,
        isWorktree: false,
        allProjects: ['memsmith'],
      }),
      resolveRuntimeContext: () => ({
        runtime: 'server',
        projectId: 'memsmith',
        serverBaseUrl: 'http://server.test',
        client: {
          searchObservations: async () => ({ observations: [] }),
        },
      }),
    });

    const result = await contextHandler.execute({
      sessionId: 'session-empty',
      cwd: '/tmp/memsmith',
      platform: 'claude-code',
    });

    // Dashboard line is always prepended — even when no observations exist.
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
    expect(ctx).not.toContain('SEEDED:');
  });

  it('injects empty gracefully when no server runtime is reachable', async () => {
    setContextDependenciesForTesting({
      loadFromFileOnce: () => ({}),
      getProjectContext: () => ({
        primary: 'memsmith',
        parent: null,
        isWorktree: false,
        allProjects: ['memsmith'],
      }),
      resolveRuntimeContext: () => ({
        runtime: 'local',
        reason: 'server_context_unavailable',
      }),
    });

    const result = await contextHandler.execute({
      sessionId: 'session-no-runtime',
      cwd: '/tmp/memsmith',
      platform: 'claude-code',
    });

    // Dashboard line is always prepended — even when the runtime is unreachable.
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('📊 MemSmith dashboard:');
  });

  // Item 4 (2026-07-27 local-fresh-install-readiness) — identity mints on
  // UserPromptSubmit (session-init), not SessionStart. The very first
  // SessionStart in a fresh project therefore runs before any
  // .memsmith/project.json marker exists. This must degrade to the bare,
  // unscoped dashboard link — never throw, never block the welcome — and
  // self-correct on the second session once session-init has minted the
  // marker. This locks in that already-correct fallback as a regression test.
  it('emits the bare unscoped dashboard link when no project marker exists yet (never throws)', async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), 'memsmith-fresh-no-marker-'));
    try {
      setContextDependenciesForTesting({
        loadFromFileOnce: () => ({}),
        getProjectContext: () => ({
          primary: 'memsmith',
          parent: null,
          isWorktree: false,
          allProjects: ['memsmith'],
        }),
        resolveRuntimeContext: () => ({
          runtime: 'local',
          reason: 'server_context_unavailable',
        }),
      });

      const result = await contextHandler.execute({
        sessionId: 'session-fresh-no-marker',
        cwd: freshCwd,
        platform: 'claude-code',
      });

      const ctx = result.hookSpecificOutput?.additionalContext ?? '';
      // Bare link — no ?project= — because readProjectMarker(freshCwd) is
      // null (no marker written yet) and dashboardProjectId stays undefined.
      expect(ctx).toContain(`📊 MemSmith dashboard: ${resolveDashboardUrl()}`);
      expect(ctx).not.toContain('?project=');
    } finally {
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });
});
