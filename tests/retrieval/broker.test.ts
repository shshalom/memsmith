// tests/retrieval/broker.test.ts
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { SessionShownStore } from '../../src/services/retrieval/session-store.js';
import { SessionTopicStore } from '../../src/services/retrieval/topic-store.js';
import { topicKey } from '../../src/services/retrieval/topic-key.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeRuntime(observations: Array<{ id: string; content: string; metadata?: any; obs_type?: string; obsType?: string; created_at?: string; createdAtEpoch?: number }>, opts: { throws?: boolean } = {}) {
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
/** A consulted-topic store in its own temp dir, so each test starts unconsulted. */
function freshTopics() { return new SessionTopicStore('sess-x', mkdtempSync(join(tmpdir(), 'brk-t-'))); }

describe('RetrievalBroker.forPrompt', () => {
  it('injects provenance-tagged memory on a strong hit', async () => {
    // Use the real server response shape: createdAtEpoch (number) + obsType (camelCase)
    const epochMs = new Date('2026-07-10T00:00:00Z').getTime();
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'chose X because Y', obsType: 'decision', createdAtEpoch: epochMs }])), freshStore());
    const r = await b.forPrompt('why did we choose X?');
    expect(r.additionalContext).toContain('chose X because Y');
    expect(r.additionalContext).toContain('decision');
    expect(r.additionalContext).toContain('2026'); // capturedAt derived from createdAtEpoch, not unknown-date
    expect(r.additionalContext).not.toContain('unknown-date');
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

  // AMENDED 2026-08-11 (Amendment 2): fail-open still means "never block", but no
  // longer means "inject nothing" — unavailability must be VISIBLE to the user.
  it('fails open when the server throws, and surfaces unavailability', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true })), freshStore());
    const r = await b.forPrompt('q');
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.additionalContext).toMatch(/unavailable/i);
    expect(r.isGap).toBe(false); // never asked ≠ asked-and-empty
  });

  it('fails open when runtime is not server, and surfaces unavailability', async () => {
    const b = new RetrievalBroker(deps({ runtime: 'local', reason: 'x' } as any), freshStore());
    const r = await b.forPrompt('q');
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(true);
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

  // AMENDED 2026-08-11 (Amendment 1): the old design did NOT block on a miss,
  // because it keyed on "memory has hits". The predicate is now "topic not yet
  // consulted", so a miss on an unconsulted topic DOES block — the agent must
  // ask memory before falling through to code. It still flags the gap.
  it('hard mode DOES block on a miss when the topic is unconsulted', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), freshTopics());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(true);
    expect(r.isGap).toBe(true);
  });

  it('hard mode fails OPEN (no block) when server errors', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true }), hard), freshStore(), freshTopics());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(true);
  });
});

// ── Amendment 1: always-memory-first block predicate ─────────────────────────
describe('Amendment 1 — block keys on consulted-topic, not hit count', () => {
  const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };

  it('blocks on a strong hit when the topic has not been consulted', async () => {
    const b = new RetrievalBroker(
      deps(fakeRuntime([{ id: 'o1', content: 'a' }, { id: 'o2', content: 'b' }]), hard),
      freshStore(), freshTopics(),
    );
    expect((await b.forToolIntent('Grep', { pattern: 'ollama restart' })).block).toBe(true);
  });

  it('does NOT block once the topic has been consulted — the friction bound', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'a' }]), hard), freshStore(), topics);
    expect((await b.forToolIntent('Grep', { pattern: 'ollama restart' })).block).toBe(false);
  });

  it('treats reordered / punctuation-variant patterns as the SAME topic', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), topics);
    expect((await b.forToolIntent('Grep', { pattern: 'restart|ollama' })).block).toBe(false);
  });

  it('still blocks a DIFFERENT topic in the same session', async () => {
    const topics = freshTopics();
    topics.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), topics);
    expect((await b.forToolIntent('Grep', { pattern: 'postgres pool' })).block).toBe(true);
  });

  it('never blocks in soft mode', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([]), baseSettings), freshStore(), freshTopics());
    expect((await b.forToolIntent('Grep', { pattern: 'ollama' })).block).toBe(false);
  });

  it('never blocks on prompt injection, even in hard mode', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), freshTopics());
    expect((await b.forPrompt('why do we have the allowlist')).block).toBe(false);
  });

  it('does not block a non-search tool even on an unconsulted topic', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), freshTopics());
    const r = await b.forToolIntent('Edit', { file_path: '/x.ts' });
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(false);
  });

  it('does NOT mark the topic consulted itself — the broker query is not the agent asking', async () => {
    // If the broker marked here, the very call being blocked would unlock the
    // topic and the gate would never fire twice. Marking belongs to the adapter.
    const topics = freshTopics();
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore(), topics);
    await b.forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(topics.hasConsulted(topicKey('ollama restart'))).toBe(false);
  });
});

// ── Amendment 2: fail open, but never fail silent ────────────────────────────
describe('Amendment 2 — unavailability is visible and distinct from a gap', () => {
  it('distinguishes a real gap (asked, nothing recorded) from unavailability', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([])), freshStore(), freshTopics());
    const r = await b.forToolIntent('Grep', { pattern: 'ollama' });
    expect(r.isGap).toBe(true);
    expect(r.unavailable).toBe(false);
  });

  it('unavailability is NOT counted as a gap (would poison the gap corpus)', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true })), freshStore(), freshTopics());
    const r = await b.forToolIntent('Grep', { pattern: 'ollama' });
    expect(r.unavailable).toBe(true);
    expect(r.isGap).toBe(false);
  });

  it('the unavailable notice tells the agent to inform the user', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true })), freshStore(), freshTopics());
    const r = await b.forToolIntent('Grep', { pattern: 'ollama' });
    expect(r.additionalContext.toLowerCase()).toContain('user');
    expect(r.additionalContext.toLowerCase()).toContain('code-only');
  });
});
