import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionShownStore } from '../../src/services/retrieval/session-store.js';

describe('SessionShownStore', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-sess-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('returns empty set when no file yet', () => {
    const s = new SessionShownStore('sess1', base);
    expect(s.readShown().size).toBe(0);
  });

  it('persists and reads back shown ids across instances', () => {
    new SessionShownStore('sess1', base).markShown(['a', 'b']);
    const shown = new SessionShownStore('sess1', base).readShown();
    expect(shown.has('a')).toBe(true);
    expect(shown.has('b')).toBe(true);
  });

  it('markShown is additive (union with existing)', () => {
    const s = new SessionShownStore('sess1', base);
    s.markShown(['a']); s.markShown(['b']);
    expect(s.readShown().size).toBe(2);
  });

  it('corrupt file degrades to empty set, never throws', () => {
    mkdirSync(join(base, 'sess2'), { recursive: true });
    writeFileSync(join(base, 'sess2', 'shown.json'), '{not json');
    const s = new SessionShownStore('sess2', base);
    expect(s.readShown().size).toBe(0);
  });
});
