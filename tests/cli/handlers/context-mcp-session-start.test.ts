// Codex SessionStart routes injection through the `session_start_context` MCP
// tool (see cli/handlers/context.ts). This test covers that Codex path AND the
// post-worker-retirement fallback: when the MCP call is unavailable, the handler
// now falls back to DIRECT runtime injection (empty-query recent search via
// resolveRuntimeContext + ServerClient), NOT the deleted worker route.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  contextHandler,
  setContextDependenciesForTesting,
} from '../../../src/cli/handlers/context.js';
import * as realMcpClient from '../../../src/shared/mcp-client.js';

const realMcpClientSnapshot = { ...realMcpClient };

const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let mcpMode: 'success' | 'throw' | 'error' = 'success';

mock.module('../../../src/shared/mcp-client.js', () => ({
  callMcpToolOnce: async (name: string, args: Record<string, unknown>) => {
    mcpCalls.push({ name, args });
    if (mcpMode === 'throw') {
      throw new Error('mcp unavailable');
    }
    if (mcpMode === 'error') {
      return { text: 'mcp tool error', isError: true };
    }
    return { text: 'context from mcp' };
  },
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

const projectContext = {
  primary: 'repo-project',
  parent: null,
  isWorktree: false,
  allProjects: ['parent-project', 'repo-project'],
};

const runtimeSearchCalls: unknown[] = [];

function installRuntimeDeps(): void {
  runtimeSearchCalls.length = 0;
  setContextDependenciesForTesting({
    loadFromFileOnce: () => ({}),
    getProjectContext: () => ({ ...projectContext }),
    resolveRuntimeContext: () => ({
      runtime: 'server',
      projectId: 'repo-project',
      serverBaseUrl: 'http://server.test',
      client: {
        searchObservations: async (input: unknown) => {
          runtimeSearchCalls.push(input);
          return {
            observations: [
              { id: 'obs-1', projectId: 'repo-project', content: 'context from runtime', metadata: {} },
            ],
          };
        },
      },
    }),
  });
}

beforeEach(() => {
  mcpCalls.length = 0;
  mcpMode = 'success';
  installRuntimeDeps();
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

describe('contextHandler Codex SessionStart MCP path', () => {
  it('loads Codex SessionStart context through the MCP tool', async () => {
    const result = await contextHandler.execute({
      sessionId: 'session-mcp-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from mcp');
    expect(mcpCalls).toEqual([{
      name: 'session_start_context',
      args: {
        projects: ['parent-project', 'repo-project'],
        platformSource: 'codex',
      },
    }]);
    // MCP succeeded → no direct runtime search.
    expect(runtimeSearchCalls).toHaveLength(0);
  });

  it('falls back to DIRECT runtime injection when the MCP call fails', async () => {
    mcpMode = 'throw';

    const result = await contextHandler.execute({
      sessionId: 'session-mcp-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    // No worker route anymore — the handler injects real recent context off the
    // runtime instead.
    expect(result.hookSpecificOutput?.additionalContext).toBe('context from runtime');
    expect(mcpCalls).toHaveLength(1);
    expect(runtimeSearchCalls).toHaveLength(1);
    expect((runtimeSearchCalls[0] as { query: string }).query).toBe('');
  });

  it('injects non-Codex startup via the direct runtime (recent mode)', async () => {
    const result = await contextHandler.execute({
      sessionId: 'session-claude-context',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from runtime');
    // Non-Codex never touches the MCP session_start_context tool.
    expect(mcpCalls).toHaveLength(0);
    expect(runtimeSearchCalls).toHaveLength(1);
    expect((runtimeSearchCalls[0] as { projectId: string }).projectId).toBe('repo-project');
    expect((runtimeSearchCalls[0] as { platformSource: string }).platformSource).toBe('claude');
  });
});

afterAll(() => {
  mock.module('../../../src/shared/mcp-client.js', () => realMcpClientSnapshot);
});
