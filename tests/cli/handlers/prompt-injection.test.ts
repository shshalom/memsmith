import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPromptInjectionHandler } from '../../../src/cli/handlers/prompt-injection.js';
import { AnswerGateStore } from '../../../src/services/retrieval/answer-gate-store.js';

const MEMORY_BODY = 'We chose the inline queue because BullMQ needed Redis on every laptop';

function serverRuntime(opts: { throws?: boolean; observations?: Array<{ id: string; content: string }> } = {}) {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      runtime: 'server' as const,
      projectId: 'p1',
      serverBaseUrl: 'http://fake',
      client: {
        contextObservations: async (input: { query: string }) => {
          calls.push(input.query);
          if (opts.throws) throw new Error('fetch failed');
          const observations = opts.observations ?? [{ id: 'o1', content: MEMORY_BODY }];
          return { observations, context: '' };
        },
        addObservation: async () => ({}),
      } as any,
    },
  };
}

function setup(settings: Record<string, string> = {}, runtimeOpts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ms-pi-'));
  const rt = serverRuntime(runtimeOpts);
  const handler = createPromptInjectionHandler({
    loadSettings: () => ({ MEMSMITH_SEMANTIC_INJECT: 'true', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard', ...settings }),
    resolveRuntime: () => rt.runtime,
    sessionBaseDir: base,
  });
  return { handler, base, rt };
}

const run = (handler: ReturnType<typeof setup>['handler'], prompt: string, sessionId = 's1') =>
  handler.execute({ sessionId, cwd: '/tmp', prompt } as any);

describe('promptInjectionHandler — information requests', () => {
  it('injects the search directive instead of memory bodies', async () => {
    const { handler } = setup();
    const res = await run(handler, 'why did we switch the queue engine to inline?');
    const ctx = res.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('observation_search');
    expect(ctx).not.toContain(MEMORY_BODY);
  });

  it('records the turn as a pending information request', async () => {
    const { handler, base } = setup();
    await run(handler, 'why did we switch the queue engine to inline?');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(true);
  });

  it('does not record a pending request when memory is unavailable', async () => {
    const { handler, base } = setup({}, { throws: true });
    const res = await run(handler, 'why did we switch the queue engine to inline?');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
    expect(res.hookSpecificOutput?.additionalContext ?? '').toContain('UNAVAILABLE');
  });

  it('does not record a pending request when semantic injection is off', async () => {
    const { handler, base } = setup({ MEMSMITH_SEMANTIC_INJECT: 'false' });
    await run(handler, 'why did we switch the queue engine to inline?');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
  });

  it('does not treat a reference to the current conversation as an information request', async () => {
    const { handler, base } = setup();
    await run(handler, 'you just said the queue is inline — why?');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
  });
});

describe('promptInjectionHandler — task prompts', () => {
  it('injects the top-N memories as background, as before', async () => {
    const { handler } = setup();
    const res = await run(handler, 'fix the failing queue engine test');
    expect(res.hookSpecificOutput?.additionalContext ?? '').toContain(MEMORY_BODY);
  });

  it('clears a pending request left by the previous turn', async () => {
    const { handler, base } = setup();
    await run(handler, 'why did we switch the queue engine to inline?');
    await run(handler, 'fix the failing queue engine test');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
  });
});

describe('promptInjectionHandler — edge cases', () => {
  it('empty prompt → clean skip', async () => {
    const { handler } = setup();
    const res = await run(handler, '');
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput).toBeUndefined();
  });
});
