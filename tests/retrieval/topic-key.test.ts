import { describe, it, expect } from 'bun:test';
import { topicKey, sameTopic } from '../../src/services/retrieval/topic-key.js';

describe('topicKey', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(topicKey('ensureOllamaRunning')).toBe(topicKey('  ensureollamarunning '));
  });

  it('ignores regex and glob punctuation so pattern variants share a topic', () => {
    expect(topicKey('spawn|exec|ollama')).toBe(topicKey('spawn exec ollama'));
    expect(topicKey('**/*.ollama.ts')).toBe(topicKey('ollama ts'));
  });

  it('is order-insensitive so term reordering does not re-block', () => {
    expect(topicKey('ollama restart')).toBe(topicKey('restart ollama'));
  });

  it('drops terms shorter than 3 chars, which carry no topic signal', () => {
    expect(topicKey('a an ollama')).toBe(topicKey('ollama'));
  });

  it('distinguishes genuinely different topics', () => {
    expect(topicKey('ollama restart')).not.toBe(topicKey('postgres pool'));
  });

  it('returns empty string for input with no usable terms', () => {
    expect(topicKey('a * ? |')).toBe('');
  });
});

// ── Overlap matching (2026-08-11) ────────────────────────────────────────────
// Exact-match topics proved too fine-grained in real use: investigating ONE
// subject produces several rephrased searches, and each hashed to a different
// key, so each re-blocked. Measured live — three consecutive blocks on one
// investigation minutes after enforcement was enabled.
describe('sameTopic — overlap-based matching', () => {
  it('matches a topic against itself', () => {
    expect(sameTopic(topicKey('ollama restart'), [topicKey('ollama restart')])).toBe(true);
  });

  it('matches when the new query shares most terms with a consulted one', () => {
    // These are the same investigation, rephrased.
    const consulted = [topicKey('observation handler recordEvent v1 events')];
    expect(sameTopic(topicKey('recordEvent v1 events serverBaseUrl'), consulted)).toBe(true);
  });

  it('matches a narrower follow-up query (subset of a consulted topic)', () => {
    const consulted = [topicKey('ollama restart ensure running backoff')];
    expect(sameTopic(topicKey('ollama restart'), consulted)).toBe(true);
  });

  it('matches a broader follow-up query (superset of a consulted topic)', () => {
    const consulted = [topicKey('ollama restart')];
    expect(sameTopic(topicKey('ollama restart backoff'), consulted)).toBe(true);
  });

  it('does NOT match a genuinely different subject', () => {
    const consulted = [topicKey('ollama restart ensure running')];
    expect(sameTopic(topicKey('postgres pool registry tenant'), consulted)).toBe(false);
  });

  it('does NOT match on a single incidental shared term', () => {
    // 'server' appears in both but the subjects are unrelated.
    const consulted = [topicKey('ollama server restart backoff')];
    expect(sameTopic(topicKey('server settings dashboard toggle route'), consulted)).toBe(false);
  });

  it('returns false against an empty consulted set', () => {
    expect(sameTopic(topicKey('ollama restart'), [])).toBe(false);
  });

  it('returns false for an empty topic', () => {
    expect(sameTopic('', [topicKey('ollama restart')])).toBe(false);
  });

  it('matches against ANY consulted topic, not just the first', () => {
    const consulted = [topicKey('postgres pool'), topicKey('ollama restart ensure')];
    expect(sameTopic(topicKey('ollama restart'), consulted)).toBe(true);
  });
});
