import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createPromptInjectionHandler } from '../../../src/cli/handlers/prompt-injection.js';
import { AnswerGateStore } from '../../../src/services/retrieval/answer-gate-store.js';
import { createAnswerGateHandler } from '../../../src/cli/handlers/answer-gate.js';
import { topicKey } from '../../../src/services/retrieval/topic-key.js';

const MEMORY_BODY = 'We chose the inline queue because BullMQ needed Redis on every laptop';

function serverRuntime(opts: { throws?: boolean; observations?: Array<{ id: string; content: string }> } = {}) {
  const calls: string[] = [];
  const added: string[] = [];
  return {
    calls,
    added,
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
        addObservation: async (input: { content: string }) => { added.push(input.content); return {}; },
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

describe('promptInjectionHandler — everything that is not a past-work question', () => {
  for (const prompt of ['fix the failing queue engine test', 'status?', 'ok merge and push', 'how does the hook work?']) {
    it(`costs no memory search and injects nothing: ${prompt}`, async () => {
      const { handler, rt } = setup();
      const res = await run(handler, prompt);
      expect(rt.calls).toEqual([]);
      expect(res.hookSpecificOutput).toBeUndefined();
    });
  }

  it('clears a pending request left by the previous turn', async () => {
    const { handler, base } = setup();
    await run(handler, 'why did we switch the queue engine to inline?');
    await run(handler, 'fix the failing queue engine test');
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
  });
});

const TASK_NOTIFICATION = '<task-notification><task-id>x</task-id><status>completed</status>'
  + '<summary>Agent "Review" finished</summary>'
  + '<result>Earlier we decided to keep the previous design. Why did the old cache fail?</result>'
  + '</task-notification>';

describe('promptInjectionHandler — automated messages', () => {
  for (const [name, prompt] of [
    ['A task notification', TASK_NOTIFICATION],
    ['An IDE selection', '<ide_selection>The user selected: // we decided to keep the history of the queue</ide_selection>'],
  ] as const) {
    it(`${name} alone costs no search, injects nothing, and arms no gate`, async () => {
      const { handler, base, rt } = setup();
      const res = await run(handler, prompt);
      expect(rt.calls).toEqual([]);
      expect(res.hookSpecificOutput).toBeUndefined();
      expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(false);
    });
  }

  it('arms the gate for a question that arrives with a notification and searches only the question', async () => {
    const { handler, base, rt } = setup();
    await run(handler, `${TASK_NOTIFICATION}\nwhy did we switch the queue engine to inline?`);
    expect(new AnswerGateStore('s1', base).isUnsatisfied()).toBe(true);
    expect(rt.calls.join(' ')).not.toContain('task-notification');
    expect(rt.calls.join(' ')).not.toContain('old cache');
  });

  it('keys the gate topic on the question, not the notification', async () => {
    const { handler, base } = setup();
    await run(handler, `${TASK_NOTIFICATION}\nwhy did we switch the queue engine to inline?`);
    expect(new AnswerGateStore('s1', base).read()?.topic).toBe(topicKey('why did we switch the queue engine to inline?'));
  });

  it('records a memory gap with the question, not the notification', async () => {
    const { handler, rt } = setup({}, { observations: [] });
    await run(handler, `${TASK_NOTIFICATION}\nwhy did we switch the queue engine to inline?`);
    expect(rt.added).toHaveLength(1);
    expect(rt.added[0]).toContain('why did we switch the queue engine to inline?');
    expect(rt.added[0]).not.toContain('task-notification');
  });

  it('keeps private content out of the search and the memory gap', async () => {
    const { handler, rt } = setup({}, { observations: [] });
    await run(handler, `<private>token-4417</private> ${TASK_NOTIFICATION}\nwhy did we switch the queue engine to inline?`);
    expect(rt.calls.length).toBeGreaterThan(0);
    expect(rt.calls.join(' ')).not.toContain('token-4417');
    expect(rt.added.join(' ')).not.toContain('token-4417');
  });

  it('a run of notification-only turns after a blocked question never blocks Stop again', async () => {
    const { handler, base } = setup();
    const stopHandler = createAnswerGateHandler({
      loadSettings: () => ({ MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }),
      resolveRuntime: () => ({ runtime: 'server', projectId: 'p1', serverBaseUrl: 'http://fake', client: {} } as any),
      sessionBaseDir: base,
      summarize: { async execute() { return { continue: true, suppressOutput: true }; } },
    });
    const stop = () => stopHandler.execute({ sessionId: 's1', cwd: '/tmp', transcriptPath: '/tmp/t.jsonl' } as any);

    await run(handler, 'why did we switch the queue engine to inline?');
    expect((await stop()).decision).toBe('block');
    for (let i = 0; i < 3; i++) {
      await run(handler, TASK_NOTIFICATION);
      expect((await stop()).decision).toBeUndefined();
    }
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

describe('promptInjectionHandler — directive reflects the mode', () => {
  it('warns about the Stop gate only in hard mode', async () => {
    const hard = await run(setup().handler, 'why did we switch the queue engine to inline?');
    const soft = await run(setup({ MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' }).handler, 'why did we switch the queue engine to inline?');
    expect(hard.hookSpecificOutput?.additionalContext ?? '').toContain('Hard mode');
    expect(soft.hookSpecificOutput?.additionalContext ?? '').not.toContain('Hard mode');
  });
});
