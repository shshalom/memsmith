import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  currentFeatureSwitches,
  isFeatureEnabled,
  accessSummary,
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
  it('lets the session environment override the settings.json access in both directions', () => {
    expect(resolveFeatureSwitches({ MEMSMITH_ACCESS: 'write' }, { MEMSMITH_ACCESS: 'read' }).access).toBe('read');
    expect(resolveFeatureSwitches({ MEMSMITH_ACCESS: 'read' }, { MEMSMITH_ACCESS: 'write' }).access).toBe('write');
    expect(resolveFeatureSwitches({ MEMSMITH_ACCESS: 'read' }, {}).access).toBe('read');
    expect(resolveFeatureSwitches({}, {}).access).toBe('write');
  });

  it('falls through to settings.json when the session sets MEMSMITH_ACCESS to an empty value', () => {
    const s = resolveFeatureSwitches({ MEMSMITH_ACCESS: 'read' }, { MEMSMITH_ACCESS: '' });
    expect(s.access).toBe('read');
    expect(s.accessSource).toBe('settings');
  });

  it('labels where the access value came from', () => {
    expect(resolveFeatureSwitches({ MEMSMITH_ACCESS: 'write' }, {}).accessSource).toBe('settings');
    expect(resolveFeatureSwitches({}, { MEMSMITH_ACCESS: 'write' }).accessSource).toBe('env');
    expect(resolveFeatureSwitches({}, {}).accessSource).toBe('default');
  });

  it('lets an empty session variable clear a disabled list from settings.json', () => {
    const s = resolveFeatureSwitches({ MEMSMITH_HOOKS_DISABLED: 'context' }, { MEMSMITH_HOOKS_DISABLED: '' });
    expect([...s.disabled]).toEqual([]);
  });

  it('turns read access into no capture and no writes, and leaves reads on', () => {
    const read = resolveFeatureSwitches({}, { MEMSMITH_ACCESS: 'read' });
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

  it('accepts the common spellings of read-only', () => {
    for (const value of ['read', 'READ', 'readonly', 'Read-Only', 'ro', ' ro ']) {
      const s = resolveFeatureSwitches({}, { MEMSMITH_ACCESS: value });
      expect(s.access).toBe('read');
      expect(s.invalidAccess).toBeNull();
    }
  });

  it('reports an access value it does not recognize and keeps writing', () => {
    const s = resolveFeatureSwitches({}, { MEMSMITH_ACCESS: 'reed' });
    expect(s.access).toBe('write');
    expect(s.invalidAccess).toBe('reed');
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

describe('accessSummary', () => {
  it('says nothing for the default write access', () => {
    expect(accessSummary(resolveFeatureSwitches({}, {}))).toBeNull();
  });

  it('names read access and where it came from', () => {
    expect(accessSummary(resolveFeatureSwitches({}, { MEMSMITH_ACCESS: 'read' }))).toBe('read (MEMSMITH_ACCESS in the environment)');
    expect(accessSummary(resolveFeatureSwitches({ MEMSMITH_ACCESS: 'read' }, {}))).toBe('read (MEMSMITH_ACCESS in settings.json)');
  });
});
