import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionTopicStore } from '../../src/services/retrieval/topic-store.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-topic-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('SessionTopicStore', () => {
  it('reports not-consulted for a fresh session', () => {
    const s = new SessionTopicStore('sess-1', base);
    expect(s.hasConsulted('ollama restart')).toBe(false);
  });

  it('persists a consulted topic across store instances (separate hook processes)', () => {
    new SessionTopicStore('sess-1', base).markConsulted('ollama restart');
    expect(new SessionTopicStore('sess-1', base).hasConsulted('ollama restart')).toBe(true);
  });

  it('scopes topics per session', () => {
    new SessionTopicStore('sess-1', base).markConsulted('ollama restart');
    expect(new SessionTopicStore('sess-2', base).hasConsulted('ollama restart')).toBe(false);
  });

  it('does not leak across topics', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('ollama restart');
    expect(s.hasConsulted('postgres pool')).toBe(false);
  });

  it('treats a corrupt file as empty and never throws', () => {
    mkdirSync(join(base, 'sess-1'), { recursive: true });
    writeFileSync(join(base, 'sess-1', 'consulted.json'), '{not json');
    const s = new SessionTopicStore('sess-1', base);
    expect(s.hasConsulted('anything')).toBe(false);
    expect(() => s.markConsulted('x')).not.toThrow();
  });

  it('never throws when the base dir is unwritable', () => {
    const s = new SessionTopicStore('sess-1', '/proc/nonexistent-ms-test');
    expect(() => s.markConsulted('x')).not.toThrow();
    expect(s.hasConsulted('x')).toBe(false);
  });

  it('is idempotent — marking twice keeps one entry', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('ollama');
    s.markConsulted('ollama');
    expect(s.hasConsulted('ollama')).toBe(true);
  });

  it('keeps earlier topics when a new one is added', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('ollama');
    s.markConsulted('postgres');
    expect(s.hasConsulted('ollama')).toBe(true);
    expect(s.hasConsulted('postgres')).toBe(true);
  });

  it('ignores an empty topic rather than storing it', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('');
    expect(s.hasConsulted('')).toBe(false);
  });
});
