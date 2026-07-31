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

  // Identity now mints on SessionStart too (contextHandler), not only on
  // UserPromptSubmit (session-init). The old split meant the FIRST session of a
  // fresh project always printed an unscoped dashboard link, self-correcting only
  // on the second — see the assertion below for why that mattered.
  //
  // What this test still guards: when the mint cannot succeed (no reachable
  // Postgres, as here), the handler must degrade to the unscoped link rather than
  // throw or block the welcome.
  it('degrades to an unscoped dashboard link when identity cannot be minted (never throws)', async () => {
    const freshCwd = mkdtempSync(join(tmpdir(), 'memsmith-fresh-no-marker-'));
    // The comment above says the mint "cannot reach a real Postgres". On a
    // developer machine running the dogfood server it CAN: the handler resolved
    // the local base DSN itself, minted successfully, and wrote a `projects` row
    // into the live database. The temp dir is cleaned up; that row was not.
    //
    // Measured: 31 orphaned `memsmith-fresh-no-marker-*` projects accumulated in
    // the dogfood database — one per full-suite run — and surfaced in the user's
    // real project switcher, outnumbering their actual projects 2:1. The
    // assertions passed either way, so the leak was invisible.
    //
    // Overriding MEMSMITH_SERVER_DATABASE_URL does NOT fix this:
    // resolveLocalBaseDatabaseUrl reads process.env at call time and other suites
    // mutate the same variable, so whether the mint fails depends on file
    // ordering — it passed alone and failed in the full suite. The mint itself is
    // now the injectable seam, which is deterministic.
    try {
      setContextDependenciesForTesting({
        // Make the mint genuinely fail, so the degrade path under test is the
        // path actually exercised, and no test can write to the developer's DB.
        mintProjectIdentity: async () => null,
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
      // This test previously asserted a BARE link here — which encoded the bug.
      // The mint used to happen only in sessionInitHandler (UserPromptSubmit,
      // i.e. the user's first message), strictly AFTER this line, so a new
      // project's first session always printed an unscoped link and only the
      // second session showed the right one. That is not cosmetic: one server
      // serves every local project, so an unscoped link lands on whichever
      // project the SERVER booted from — a link into another project's memory,
      // and a Go Team wizard opened from there would act on that project.
      //
      // contextHandler now mints when no marker exists, so the link is scoped on
      // the FIRST session. In this test the mint cannot reach a real Postgres, so
      // ensureProjectIdentityForHook returns null and the link degrades to the
      // unscoped form — which is the behaviour that must never throw.
      expect(ctx).toContain('📊 MemSmith dashboard:');
      expect(result.continue).not.toBe(false);
      // The link must be UNSCOPED — that is the degrade behaviour under test.
      // Asserting it also proves the mint really failed, so this test can no
      // longer silently start writing to a live database again.
      expect(ctx).not.toMatch(/\?project=/);
    } finally {
      rmSync(freshCwd, { recursive: true, force: true });
    }
  });
});
