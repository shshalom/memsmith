import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  currentFeatureSwitches,
  isFeatureEnabled,
  memoryModeSummary,
  resetFeatureSwitchesForTesting,
  resolveFeatureSwitches,
  writesAllowed,
} from '../../src/shared/feature-switches.js';
import { logger } from '../../src/utils/logger.js';

afterEach(() => {
  resetFeatureSwitchesForTesting();
  spyOn(logger, 'warn').mockRestore();
});

describe('resolveFeatureSwitches', () => {
  it('lets the session environment override the settings.json mode in both directions', () => {
    expect(resolveFeatureSwitches({ MEMSMITH_MODE: 'write' }, { MEMSMITH_MODE: 'read' }).mode).toBe('read');
    expect(resolveFeatureSwitches({ MEMSMITH_MODE: 'read' }, { MEMSMITH_MODE: 'write' }).mode).toBe('write');
    expect(resolveFeatureSwitches({ MEMSMITH_MODE: 'read' }, {}).mode).toBe('read');
    expect(resolveFeatureSwitches({}, {}).mode).toBe('write');
  });

  it('lets an empty session variable clear a disabled list from settings.json', () => {
    const s = resolveFeatureSwitches({ MEMSMITH_HOOKS_DISABLED: 'context' }, { MEMSMITH_HOOKS_DISABLED: '' });
    expect([...s.disabled]).toEqual([]);
  });

  it('turns read mode into no capture and no writes, and leaves reads on', () => {
    const read = resolveFeatureSwitches({}, { MEMSMITH_MODE: 'read' });
    expect(writesAllowed(read)).toBe(false);
    expect(isFeatureEnabled('capture', read)).toBe(false);
    expect(isFeatureEnabled('summary', read)).toBe(false);
    expect(isFeatureEnabled('context', read)).toBe(true);
    expect(isFeatureEnabled('answer-gate', read)).toBe(true);
  });

  it('treats summary as part of capture', () => {
    const s = resolveFeatureSwitches({}, { MEMSMITH_HOOKS_DISABLED: 'capture' });
    expect(isFeatureEnabled('summary', s)).toBe(false);
    expect(writesAllowed(s)).toBe(true);
  });

  it('reads a mode profile left in an older settings.json as write, without a warning', () => {
    for (const profile of ['code', 'code--es', 'code--chill']) {
      const s = resolveFeatureSwitches({ MEMSMITH_MODE: profile }, {});
      expect(s.mode).toBe('write');
      expect(s.invalidMode).toBeNull();
    }
  });

  it('reports a mode it does not recognize and keeps writing', () => {
    const s = resolveFeatureSwitches({}, { MEMSMITH_MODE: 'readonly' });
    expect(s.mode).toBe('write');
    expect(s.invalidMode).toBe('readonly');
  });
});

describe('currentFeatureSwitches', () => {
  it('warns about an unknown feature name once, not on every check', () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const env = { MEMSMITH_HOOKS_DISABLED: 'context,promt-injection' };
    const s = currentFeatureSwitches(env);
    currentFeatureSwitches(env);
    expect(s.unknownFeatures).toEqual(['promt-injection']);
    expect([...s.disabled]).toEqual(['context']);
    const unknownWarnings = warn.mock.calls.filter((c) => String(c[1]).includes('promt-injection'));
    expect(unknownWarnings).toHaveLength(1);
  });
});

describe('memoryModeSummary', () => {
  it('says nothing for the default write mode', () => {
    expect(memoryModeSummary(resolveFeatureSwitches({}, {}))).toBeNull();
  });

  it('names read mode and where it came from', () => {
    expect(memoryModeSummary(resolveFeatureSwitches({}, { MEMSMITH_MODE: 'read' }))).toBe('read (MEMSMITH_MODE in the environment)');
    expect(memoryModeSummary(resolveFeatureSwitches({ MEMSMITH_MODE: 'read' }, {}))).toBe('read (MEMSMITH_MODE in settings.json)');
  });
});
