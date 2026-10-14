import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAnswerGateHandler } from '../../../src/cli/handlers/answer-gate.js';
import { AnswerGateStore } from '../../../src/services/retrieval/answer-gate-store.js';
import { ANSWER_GATE_BLOCK_REASON } from '../../../src/services/retrieval/directive.js';
import type { NormalizedHookInput } from '../../../src/cli/types.js';

const SERVER = { runtime: 'server', projectId: 'p1', serverBaseUrl: 'http://fake', client: {} } as any;
const LOCAL = { runtime: 'local', reason: 'server_context_unavailable' } as any;

function setup(opts: { mode?: string; runtime?: any; pending?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ms-ag-'));
  const store = new AnswerGateStore('s1', base);
  if (opts.pending ?? true) store.beginTurn({ pending: true, topic: 'queue engine inline' });
  const summarized: NormalizedHookInput[] = [];
  const handler = createAnswerGateHandler({
    loadSettings: () => ({ MEMSMITH_RETRIEVAL_ENFORCEMENT: opts.mode ?? 'hard' }),
    resolveRuntime: () => opts.runtime ?? SERVER,
    sessionBaseDir: base,
    summarize: {
      async execute(input) {
        summarized.push(input);
        return { continue: true, suppressOutput: true };
      },
    },
  });
  return { handler, store, summarized };
}

const stop = (extra: Partial<NormalizedHookInput> = {}): NormalizedHookInput =>
  ({ sessionId: 's1', cwd: '/tmp', transcriptPath: '/tmp/t.jsonl', ...extra });

describe('answer gate (Stop)', () => {
  it('blocks an unanswered information request in hard mode with the search reason', async () => {
    const { handler } = setup();
    const res = await handler.execute(stop());
    expect(res.decision).toBe('block');
    expect(res.reason).toBe(ANSWER_GATE_BLOCK_REASON);
  });

  it('defers the summary while blocking, since the turn has not ended', async () => {
    const { handler, summarized } = setup();
    await handler.execute(stop());
    expect(summarized).toHaveLength(0);
  });

  it('never blocks when Claude Code is already continuing from a Stop block', async () => {
    const { handler } = setup();
    const res = await handler.execute(stop({ stopHookActive: true }));
    expect(res.decision).toBeUndefined();
  });

  it('never blocks the same turn twice', async () => {
    const { handler } = setup();
    expect((await handler.execute(stop())).decision).toBe('block');
    expect((await handler.execute(stop())).decision).toBeUndefined();
  });

  it('does not block once memory has been searched', async () => {
    const { handler, store } = setup();
    store.markSatisfied();
    expect((await handler.execute(stop())).decision).toBeUndefined();
  });

  it('does not block a turn with no information request', async () => {
    const { handler } = setup({ pending: false });
    expect((await handler.execute(stop())).decision).toBeUndefined();
  });

  it('never blocks in soft mode', async () => {
    const { handler } = setup({ mode: 'soft' });
    expect((await handler.execute(stop())).decision).toBeUndefined();
  });

  it('never blocks when memory is unavailable', async () => {
    const { handler } = setup({ runtime: LOCAL });
    expect((await handler.execute(stop())).decision).toBeUndefined();
  });

  it('never blocks a subagent stop', async () => {
    const { handler } = setup();
    expect((await handler.execute(stop({ agentId: 'sub-1' }))).decision).toBeUndefined();
  });

  it('still summarizes when it does not block', async () => {
    const { handler, summarized } = setup({ pending: false });
    await handler.execute(stop());
    expect(summarized).toHaveLength(1);
  });

  it('summarizes the continued turn after its own block', async () => {
    const { handler, summarized } = setup();
    await handler.execute(stop());
    await handler.execute(stop({ stopHookActive: true }));
    expect(summarized).toHaveLength(1);
    expect(summarized[0].stopHookActive).not.toBe(true);
  });

  it('still summarizes when the gate itself fails', async () => {
    const summarized: NormalizedHookInput[] = [];
    const handler = createAnswerGateHandler({
      loadSettings: () => { throw new Error('settings exploded'); },
      resolveRuntime: () => SERVER,
      summarize: { async execute(input) { summarized.push(input); return { continue: true }; } },
    });
    const res = await handler.execute(stop());
    expect(res.decision).toBeUndefined();
    expect(summarized).toHaveLength(1);
  });
});
