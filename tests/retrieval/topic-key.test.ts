import { describe, it, expect } from 'bun:test';
import { topicKey } from '../../src/services/retrieval/topic-key.js';

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
