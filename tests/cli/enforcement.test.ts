import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setEnforcement, readEnforcement } from '../../src/npx-cli/commands/enforcement.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-enf-'));
  file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft', MEMSMITH_OTHER: 'keep' }));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('enforcement CLI', () => {
  it('reads the current mode', () => {
    expect(readEnforcement(file)).toBe('soft');
  });

  it('flips soft -> hard', () => {
    setEnforcement('hard', file);
    expect(readEnforcement(file)).toBe('hard');
  });

  // THE drill that was never run in July: turning hard mode OFF must work
  // through a non-gated path, or the user is stuck hand-editing JSON.
  it('flips hard -> soft (the escape hatch)', () => {
    setEnforcement('hard', file);
    setEnforcement('soft', file);
    expect(readEnforcement(file)).toBe('soft');
  });

  it('preserves every other setting', () => {
    setEnforcement('hard', file);
    expect(JSON.parse(readFileSync(file, 'utf-8')).MEMSMITH_OTHER).toBe('keep');
  });

  it('defaults to soft when the key is absent', () => {
    writeFileSync(file, JSON.stringify({}));
    expect(readEnforcement(file)).toBe('soft');
  });

  it('reports soft for a missing file rather than throwing', () => {
    expect(readEnforcement(join(dir, 'nope.json'))).toBe('soft');
  });

  it('reports soft for a corrupt file rather than throwing', () => {
    writeFileSync(file, '{not json');
    expect(readEnforcement(file)).toBe('soft');
  });

  it('writes valid JSON that the settings loader can parse back', () => {
    setEnforcement('hard', file);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('recovers a corrupt file by writing a fresh one rather than throwing', () => {
    writeFileSync(file, '{not json');
    expect(() => setEnforcement('hard', file)).not.toThrow();
    expect(readEnforcement(file)).toBe('hard');
  });
});
