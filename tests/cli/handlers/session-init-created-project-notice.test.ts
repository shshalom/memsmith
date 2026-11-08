import { afterEach, describe, expect, it } from 'bun:test';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../../src/cli/handlers/session-init.js';

// When the SessionStart mint failed (for example, the server was still booting),
// the first prompt's mint created the project and nobody was told.

function useDeps(mint: () => Promise<unknown>) {
  setSessionInitDependenciesForTesting({
    mintProjectIdentity: mint as never,
    resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
    shouldTrackProject: () => true,
    logServerFallback: () => {},
  });
}

const run = () => sessionInitHandler.execute({
  sessionId: 'created-notice', cwd: '/work/fresh', platform: 'claude-code', prompt: 'hello',
});

afterEach(() => setSessionInitDependenciesForTesting({}));

describe('UserPromptSubmit created-project notice', () => {
  it('reaches the turn whose mint created the project', async () => {
    useDeps(async () => ({ teamId: 't', projectId: 'p', created: { root: '/work/fresh', name: 'fresh' } }));
    const result = await run();
    expect(result.suppressOutput).toBe(false);
    expect(result.hookSpecificOutput?.additionalContext)
      .toBe('MemSmith created project fresh for /work/fresh. Run `memsmith project` to check it, or `memsmith link` to use a different project.');
  });

  it('carries the borrowed-project notice on the first prompt that sees it', async () => {
    setSessionInitDependenciesForTesting({
      mintProjectIdentity: (async () => ({ teamId: 't', projectId: 'p' })) as never,
      projectNotice: async () => 'MemSmith is using project ws from /work for this folder.',
      resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
      shouldTrackProject: () => true,
      logServerFallback: () => {},
    });
    const result = await run();
    expect(result.hookSpecificOutput?.additionalContext).toBe('MemSmith is using project ws from /work for this folder.');
  });

  it('stays silent when the project already existed', async () => {
    useDeps(async () => ({ teamId: 't', projectId: 'p' }));
    const result = await run();
    expect(result.hookSpecificOutput).toBeUndefined();
    expect(result.suppressOutput).toBe(true);
  });
});
