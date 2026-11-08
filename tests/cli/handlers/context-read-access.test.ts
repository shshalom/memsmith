import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { contextHandler, setContextDependenciesForTesting } from '../../../src/cli/handlers/context.js';

// A read-only worker started in a new folder must not create or register a
// project; its read tools report that the folder has no project instead.

const cwd = mkdtempSync(join(tmpdir(), 'ms-ctx-read-'));
const previous = process.env.MEMSMITH_ACCESS;

afterEach(() => {
  setContextDependenciesForTesting({});
  if (previous === undefined) delete process.env.MEMSMITH_ACCESS;
  else process.env.MEMSMITH_ACCESS = previous;
});

async function sessionStart(access: string | undefined): Promise<{ mints: number; text: string }> {
  if (access === undefined) delete process.env.MEMSMITH_ACCESS;
  else process.env.MEMSMITH_ACCESS = access;
  let mints = 0;
  setContextDependenciesForTesting({
    mintProjectIdentity: async () => { mints++; return { teamId: 't', projectId: 'p', created: { root: cwd, name: 'fresh' } }; },
    loadFromFileOnce: () => ({}),
    getProjectContext: () => ({ primary: 'fresh', parent: null, isWorktree: false, allProjects: ['fresh'] }),
    resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
    checkGenerationReadiness: async () => null,
    checkServerVersion: async () => null,
    checkSetup: async () => null,
  } as never);
  const result = await contextHandler.execute({ sessionId: 's', cwd, platform: 'claude' } as never);
  return { mints, text: (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext };
}

describe('SessionStart with MEMSMITH_ACCESS=read', () => {
  it('creates the project in a writing session', async () => {
    const { mints, text } = await sessionStart(undefined);
    expect(mints).toBe(1);
    expect(text).toContain('MemSmith created project fresh');
  });

  it('never creates or registers a project in a read-only session', async () => {
    const { mints, text } = await sessionStart('read');
    expect(mints).toBe(0);
    expect(text).not.toContain('MemSmith created project');
    expect(text).toContain('MEMSMITH_ACCESS=read');
  });
});

process.on('exit', () => rmSync(cwd, { recursive: true, force: true }));
