// tests/retrieval/broker.test.ts
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { CONSULT_WINDOW_MS, SessionTopicStore } from '../../src/services/retrieval/topic-store.js';
import { topicKey } from '../../src/services/retrieval/topic-key.js';
import { MEMORY_FIRST_GATE_REASON, MEMORY_FIRST_NUDGE } from '../../src/services/retrieval/directive.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeRuntime(observations: Array<{ id: string; content: string }>, opts: { throws?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      runtime: 'server' as const,
      projectId: 'proj-1',
      serverBaseUrl: 'http://x',
      client: {
        contextObservations: async ({ query }: { query: string }) => {
          calls.push(query);
          if (opts.throws) throw new Error('server down');
          return { observations, context: '' };
        },
      } as any,
    },
  };
}
const soft = { MEMSMITH_RETRIEVAL_MIN_HITS: '1', MEMSMITH_RETRIEVAL_TIMEOUT_MS: '2000', MEMSMITH_SEMANTIC_INJECT_LIMIT: '5', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' };
const hard = { ...soft, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
const deps = (runtime: any, settings: Record<string, string>) => ({ runtime, settings, sessionId: 'sess-x', nowIso: '2026-07-15T00:00:00Z', memoryReachable: async () => true });
function freshTopics() { return new SessionTopicStore('sess-x', mkdtempSync(join(tmpdir(), 'brk-t-'))); }

describe('RetrievalBroker.forToolIntent — memory first when the agent reaches out', () => {
  it('blocks a search on an unconsulted topic in hard mode, telling the agent to remember first', async () => {
    const rt = fakeRuntime([]);
    const r = await new RetrievalBroker(deps(rt.runtime, hard), freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r.block).toBe(true);
    expect(r.blockReason).toBe(MEMORY_FIRST_GATE_REASON);
  });

  it('reminds without blocking in soft mode', async () => {
    const rt = fakeRuntime([]);
    const r = await new RetrievalBroker(deps(rt.runtime, soft), freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r.block).toBe(false);
    expect(r.additionalContext).toBe(MEMORY_FIRST_NUDGE);
  });

  it('runs no memory query of its own and injects no memories', async () => {
    const rt = fakeRuntime([{ id: 'o1', content: 'stale note about ollama' }]);
    const r = await new RetrievalBroker(deps(rt.runtime, hard), freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(rt.calls).toEqual([]);
    expect(r.additionalContext).not.toContain('stale note');
  });

  it('lets the search through once memory was consulted for the topic', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('ollama restart'));
    const r = await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), topics).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r).toMatchObject({ block: false, additionalContext: '' });
  });

  it('treats reordered or punctuation-variant patterns as the same topic', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('ollama restart'));
    const r = await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), topics).forToolIntent('Grep', { pattern: 'restart|ollama' });
    expect(r.block).toBe(false);
  });

  it('blocks a different topic once the consult window has passed', async () => {
    let now = 1_000_000;
    const topics = new SessionTopicStore('sess-x', mkdtempSync(join(tmpdir(), 'brk-t-')), () => now);
    topics.markConsulted(topicKey('ollama restart'));
    now += CONSULT_WINDOW_MS + 1;
    const r = await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), topics).forToolIntent('Grep', { pattern: 'postgres pool' });
    expect(r.block).toBe(true);
  });

  it('lets a code-identifier search through right after a memory consult', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('why does generation fail on a fresh install'));
    const r = await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), topics).forToolIntent('Grep', { pattern: 'ollamaCanGenerate' });
    expect(r.block).toBe(false);
  });

  it('ignores tools that do not reach out for information', async () => {
    const r = await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), freshTopics()).forToolIntent('Edit', { file_path: '/x.ts' });
    expect(r).toMatchObject({ block: false, additionalContext: '' });
  });

  it('does not mark the topic consulted itself; only a memory tool call does', async () => {
    const topics = freshTopics();
    await new RetrievalBroker(deps(fakeRuntime([]).runtime, hard), topics).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(topics.hasConsulted(topicKey('ollama restart'))).toBe(false);
  });
});

describe('RetrievalBroker.forToolIntent — fails open when memory cannot be consulted', () => {
  it('allows with a visible notice when the runtime has no memory server', async () => {
    const local = { runtime: 'local', reason: 'server_context_unavailable' };
    const r = await new RetrievalBroker(deps(local, hard), freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.additionalContext).toContain('UNAVAILABLE');
  });

  it('allows with a visible notice when the memory server does not answer', async () => {
    const d = { ...deps(fakeRuntime([]).runtime, hard), memoryReachable: async () => false };
    const r = await new RetrievalBroker(d, freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r).toMatchObject({ block: false, unavailable: true });
  });

  it('still blocks when the memory server answers', async () => {
    const d = { ...deps(fakeRuntime([]).runtime, hard), memoryReachable: async () => true };
    expect((await new RetrievalBroker(d, freshTopics()).forToolIntent('Grep', { pattern: 'ollama restart' })).block).toBe(true);
  });
});

describe('RetrievalBroker.probe', () => {
  it('reports a gap when memory holds nothing for the question', async () => {
    expect(await new RetrievalBroker(deps(fakeRuntime([]).runtime, soft), freshTopics()).probe('why the allowlist'))
      .toEqual({ unavailable: false, isGap: true });
  });

  it('reports memory unavailable instead of a gap when the server fails', async () => {
    expect(await new RetrievalBroker(deps(fakeRuntime([], { throws: true }).runtime, soft), freshTopics()).probe('why the allowlist'))
      .toEqual({ unavailable: true, isGap: false });
  });
});
