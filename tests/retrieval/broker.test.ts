// tests/retrieval/broker.test.ts
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { SessionShownStore } from '../../src/services/retrieval/session-store.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeRuntime(observations: Array<{ id: string; content: string; metadata?: any; obs_type?: string; created_at?: string }>, opts: { throws?: boolean } = {}) {
  return {
    runtime: 'server' as const,
    projectId: 'proj-1',
    serverBaseUrl: 'http://x',
    client: {
      contextObservations: async () => {
        if (opts.throws) throw new Error('server down');
        return { observations, context: observations.map(o => o.content).join('\n') };
      },
    } as any,
  };
}
const baseSettings = { MEMSMITH_RETRIEVAL_MIN_HITS: '1', MEMSMITH_RETRIEVAL_TIMEOUT_MS: '2000', MEMSMITH_SEMANTIC_INJECT_LIMIT: '5', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' };
const deps = (runtime: any, settings = baseSettings) => ({ runtime, settings, sessionId: 'sess-x', nowIso: '2026-07-15T00:00:00Z' });
function freshStore() { return new SessionShownStore('sess-x', mkdtempSync(join(tmpdir(), 'brk-'))); }

describe('RetrievalBroker.forPrompt', () => {
  it('injects provenance-tagged memory on a strong hit', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'chose X because Y', obs_type: 'decision', created_at: '2026-07-10T00:00:00Z' }])), freshStore());
    const r = await b.forPrompt('why did we choose X?');
    expect(r.additionalContext).toContain('chose X because Y');
    expect(r.additionalContext).toContain('decision');
    expect(r.isGap).toBe(false);
    expect(r.block).toBe(false); // soft
  });

  it('gap-flags when result count < MIN_HITS', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([])), freshStore());
    const r = await b.forPrompt('why did we choose X?');
    expect(r.isGap).toBe(true);
    expect(r.additionalContext.toLowerCase()).toContain('no memsmith memory');
    expect(r.block).toBe(false);
  });

  it('dedups already-shown ids within a session', async () => {
    const store = freshStore();
    const rt = fakeRuntime([{ id: 'o1', content: 'first', obs_type: 'decision' }]);
    const b1 = new RetrievalBroker(deps(rt), store);
    await b1.forPrompt('q');
    const b2 = new RetrievalBroker(deps(rt), store);
    const r2 = await b2.forPrompt('q');
    expect(r2.additionalContext).toBe(''); // already shown → nothing new to inject
  });

  it('fails open when the server throws (no injection, no block, no throw)', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true })), freshStore());
    const r = await b.forPrompt('q');
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
  });

  it('fails open when runtime is not server', async () => {
    const b = new RetrievalBroker(deps({ runtime: 'local', reason: 'x' } as any), freshStore());
    const r = await b.forPrompt('q');
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
  });
});

describe('RetrievalBroker.forToolIntent', () => {
  it('non-search tool → no-op (no injection, no block)', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'x' }])), freshStore());
    const r = await b.forToolIntent('Edit', { file_path: '/a.ts' });
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
    expect(r.hitCount).toBe(0);
  });

  it('search tool + strong hit + soft → injects, never blocks', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'port chosen here', obs_type: 'discovery' }])), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'port' });
    expect(r.additionalContext).toContain('port chosen here');
    expect(r.block).toBe(false);
  });

  it('search tool + strong hit + hard → block once with reason', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'answer', obs_type: 'decision' }]), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(true);
    expect((r.blockReason ?? '').toLowerCase()).toContain('memsmith memory first');
  });

  it('hard mode NEVER blocks on a miss (fewer than MIN_HITS)', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(false);
    expect(r.isGap).toBe(true);
  });

  it('hard mode fails OPEN (no block) when server errors', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true }), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(false);
  });
});
