import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realCaptureSpool from '../../../src/cli/handlers/capture-spool.js';
import { logger } from '../../../src/utils/logger.js';
import { createRecordIntentHandler } from '../../../src/cli/handlers/record-intent.js';
import { createPromptInjectionHandler } from '../../../src/cli/handlers/prompt-injection.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realCaptureSpoolSnapshot = { ...realCaptureSpool };

let events: Array<{ payload: Record<string, unknown> }> = [];
let spooled: Array<{ payload: Record<string, unknown> }> = [];
let previousActor: string | undefined;
let loggerSpies: ReturnType<typeof spyOn>[] = [];

function serverRuntime() {
  return {
    runtime: 'server' as const,
    projectId: 'proj-1',
    serverBaseUrl: 'http://fake',
    client: {
      recordEvent: async (req: { payload: Record<string, unknown> }) => {
        events.push(req);
        return { event: { id: 'e1', projectId: 'proj-1', serverSessionId: null } };
      },
    },
  };
}

function useRuntime(runtime: unknown) {
  mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
    ...realRuntimeSelectorSnapshot,
    resolveRuntimeContext: () => runtime,
    selectRuntime: () => 'local' as const,
    logServerFallback: () => {},
  }));
}

const toolInput = {
  sessionId: 'sess-actor',
  cwd: '/tmp',
  platform: 'claude-code',
  toolName: 'Read',
  toolInput: { file_path: '/tmp/a.ts' },
  toolResponse: { content: 'x' },
};

beforeEach(() => {
  events = [];
  spooled = [];
  previousActor = process.env.MEMSMITH_ACTOR;
  delete process.env.MEMSMITH_ACTOR;
  loggerSpies = (['info', 'debug', 'warn', 'error', 'dataIn'] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {}));
  mock.module('../../../src/cli/handlers/capture-spool.js', () => ({
    ...realCaptureSpoolSnapshot,
    spoolEvent: (_path: string, event: { payload: Record<string, unknown> }) => { spooled.push(event); },
  }));
});

afterEach(() => {
  if (previousActor === undefined) delete process.env.MEMSMITH_ACTOR;
  else process.env.MEMSMITH_ACTOR = previousActor;
  loggerSpies.forEach((spy) => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../../src/cli/handlers/capture-spool.js', () => realCaptureSpoolSnapshot);
});

describe('captured events carry the actor', () => {
  it('stamps MEMSMITH_ACTOR on a tool-use event', async () => {
    process.env.MEMSMITH_ACTOR = ' reviewer ';
    useRuntime(serverRuntime());
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute(toolInput as never);
    expect(events).toHaveLength(1);
    expect(events[0].payload.actor).toBe('reviewer');
  });

  it('names a subagent event by its subagent type when MEMSMITH_ACTOR is unset', async () => {
    useRuntime(serverRuntime());
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute({ ...toolInput, agentId: 'agent-7', agentType: 'code-reviewer' } as never);
    expect(events[0].payload.actor).toBe('code-reviewer');
  });

  it('leaves a main-session event without an actor', async () => {
    useRuntime(serverRuntime());
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute(toolInput as never);
    expect(events[0].payload).not.toHaveProperty('actor');
  });

  it('keeps the actor on an event spooled while no server is reachable', async () => {
    process.env.MEMSMITH_ACTOR = 'reviewer';
    useRuntime({ runtime: 'none' });
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    await observationHandler.execute(toolInput as never);
    expect(events).toHaveLength(0);
    expect(spooled).toHaveLength(1);
    expect(spooled[0].payload.actor).toBe('reviewer');
  });

  it('stamps the actor on a file-edit event', async () => {
    process.env.MEMSMITH_ACTOR = 'reviewer';
    useRuntime(serverRuntime());
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');
    await fileEditHandler.execute({ sessionId: 's', cwd: '/tmp', filePath: '/tmp/a.ts', edits: [] } as never);
    expect(events[0].payload.actor).toBe('reviewer');
  });
});

describe('hook-written observations carry the actor', () => {
  it('sends the actor with the record-intent backstop', async () => {
    process.env.MEMSMITH_ACTOR = 'reviewer';
    const sent: Array<Record<string, unknown>> = [];
    const handler = createRecordIntentHandler({
      loadSettings: () => ({ MEMSMITH_RECORD_INTENT_BACKSTOP: 'true' }),
      resolveRuntime: () => ({
        runtime: 'server',
        projectId: 'proj-1',
        client: { recordIntent: async (req: Record<string, unknown>) => { sent.push(req); return { recorded: true }; } },
      }) as never,
      armedStore: () => ({ write: () => {} }),
    });
    await handler.execute({ sessionId: 's', cwd: '/tmp', prompt: 'remember that the cache TTL is 5 minutes' } as never);
    expect(sent).toEqual([{ projectId: 'proj-1', prompt: 'remember that the cache TTL is 5 minutes', actor: 'reviewer' }]);
  });

  it('stamps the actor on a memory-gap observation', async () => {
    process.env.MEMSMITH_ACTOR = 'reviewer';
    const added: Array<{ metadata?: Record<string, unknown> }> = [];
    const runtime = {
      runtime: 'server',
      projectId: 'proj-1',
      client: {
        searchObservations: async () => ({ observations: [] }),
        contextObservations: async () => ({ observations: [], context: '' }),
        addObservation: async (req: { metadata?: Record<string, unknown> }) => { added.push(req); return { memory: {} }; },
      },
    };
    const handler = createPromptInjectionHandler({
      loadSettings: () => ({ MEMSMITH_SEMANTIC_INJECT: 'true' }),
      resolveRuntime: () => runtime as never,
      sessionBaseDir: (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/ms-actor-gap-`),
    });
    await handler.execute({ sessionId: 's', cwd: '/tmp', prompt: 'why did we choose postgres over sqlite?' } as never);
    expect(added).toHaveLength(1);
    expect(added[0].metadata).toEqual({ memoryGap: true, actor: 'reviewer' });
  });
});
