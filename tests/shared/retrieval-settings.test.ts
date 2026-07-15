import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('retrieval-first settings defaults', () => {
  it('semantic inject is ON by default (core behavior)', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.MEMSMITH_SEMANTIC_INJECT).toBe('true');
  });
  it('exposes retrieval knobs with correct defaults', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.MEMSMITH_RETRIEVAL_MIN_HITS).toBe('1');
    expect(d.MEMSMITH_RETRIEVAL_TIMEOUT_MS).toBe('2000');
    expect(d.MEMSMITH_RETRIEVAL_ENFORCEMENT).toBe('soft');
  });
});
