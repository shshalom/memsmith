import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setEnforcement, readEnforcement, readEnforcementStatus, formatEnforcementStatus } from '../../src/npx-cli/commands/enforcement.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const NO_ENV = {};

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
    expect(readEnforcement(file, NO_ENV)).toBe('soft');
  });

  it('flips soft -> hard', () => {
    setEnforcement('hard', file);
    expect(readEnforcement(file, NO_ENV)).toBe('hard');
  });

  // THE drill that was never run in July: turning hard mode OFF must work
  // through a non-gated path, or the user is stuck hand-editing JSON.
  it('flips hard -> soft (the escape hatch)', () => {
    setEnforcement('hard', file);
    setEnforcement('soft', file);
    expect(readEnforcement(file, NO_ENV)).toBe('soft');
  });

  it('preserves every other setting', () => {
    setEnforcement('hard', file);
    expect(JSON.parse(readFileSync(file, 'utf-8')).MEMSMITH_OTHER).toBe('keep');
  });

  // The runtime default is 'hard'; status used to report 'soft' here, telling
  // the user enforcement was off while hooks were enforcing it.
  it('reports the runtime default when the key is absent', () => {
    writeFileSync(file, JSON.stringify({}));
    expect(readEnforcementStatus(file, NO_ENV)).toEqual({ mode: 'hard', source: 'default' });
  });

  it('takes the default from the same table the runtime reads', () => {
    writeFileSync(file, JSON.stringify({}));
    const runtimeDefault = SettingsDefaultsManager.getAllDefaults().MEMSMITH_RETRIEVAL_ENFORCEMENT;
    expect(readEnforcement(file, NO_ENV)).toBe(runtimeDefault === 'hard' ? 'hard' : 'soft');
  });

  it('reports the default for a missing file rather than throwing', () => {
    expect(readEnforcementStatus(join(dir, 'nope.json'), NO_ENV)).toEqual({ mode: 'hard', source: 'default' });
  });

  it('reports the default for a corrupt file, as the runtime falls back to defaults', () => {
    writeFileSync(file, '{not json');
    expect(readEnforcementStatus(file, NO_ENV)).toEqual({ mode: 'hard', source: 'default' });
  });

  it('says when the mode is set explicitly in settings.json', () => {
    expect(readEnforcementStatus(file, NO_ENV)).toEqual({ mode: 'soft', source: 'settings' });
  });

  it('reads the nested env schema the runtime still accepts', () => {
    writeFileSync(file, JSON.stringify({ env: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' } }));
    expect(readEnforcementStatus(file, NO_ENV)).toEqual({ mode: 'soft', source: 'settings' });
  });

  it('lets the environment variable win, as the runtime does', () => {
    expect(readEnforcementStatus(file, { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' })).toEqual({ mode: 'hard', source: 'env' });
  });

  it('formats the source into the status line', () => {
    expect(formatEnforcementStatus({ mode: 'hard', source: 'default' })).toBe('memory-first enforcement: hard (default)');
    expect(formatEnforcementStatus({ mode: 'soft', source: 'settings' })).toBe('memory-first enforcement: soft (set in settings.json)');
  });

  it('writes valid JSON that the settings loader can parse back', () => {
    setEnforcement('hard', file);
    expect(() => JSON.parse(readFileSync(file, 'utf-8'))).not.toThrow();
  });

  it('recovers a corrupt file by writing a fresh one rather than throwing', () => {
    writeFileSync(file, '{not json');
    expect(() => setEnforcement('hard', file)).not.toThrow();
    expect(readEnforcement(file, NO_ENV)).toBe('hard');
  });
});
