import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { contextHandler, setContextDependenciesForTesting } from '../../../src/cli/handlers/context.js';

// A new project used to appear silently, so a user whose folder resolved to
// nothing never learned that a separate project now held its memory.

const cwd = mkdtempSync(join(tmpdir(), 'ms-created-'));

afterEach(() => setContextDependenciesForTesting({}));

function deps(mint: () => Promise<unknown>) {
  return {
    mintProjectIdentity: mint,
    loadFromFileOnce: () => ({}),
    getProjectContext: () => ({ primary: 'fresh', parent: null, isWorktree: false, allProjects: ['fresh'] }),
    resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
    checkGenerationReadiness: async () => null,
    checkServerVersion: async () => null,
    checkSetup: async () => null,
  };
}

async function contextFor(mint: () => Promise<unknown>): Promise<string> {
  setContextDependenciesForTesting(deps(mint) as never);
  const result = await contextHandler.execute({ sessionId: 's', cwd, platform: 'claude', hookEvent: 'SessionStart' } as never);
  return (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe('SessionStart created-project notice', () => {
  it('names the project and its root on the session that created it', async () => {
    const text = await contextFor(async () => ({ teamId: 't', projectId: 'p', created: { root: '/work/fresh', name: 'fresh' } }));
    expect(text).toContain('MemSmith created project fresh for /work/fresh in your local team.');
    expect(text).toContain('`memsmith project`');
    expect(text).toContain('`memsmith link`');
  });

  it('stays silent on a session that found an existing project', async () => {
    const text = await contextFor(async () => ({ teamId: 't', projectId: 'p' }));
    expect(text).not.toContain('MemSmith created project');
  });
});

process.on('exit', () => rmSync(cwd, { recursive: true, force: true }));
