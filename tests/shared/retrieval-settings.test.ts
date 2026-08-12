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
  });
  // Changed 2026-08-11 from 'soft'. Memory-first is core behavior, so enforcement
  // ships ON: an instruction the agent can ignore is not a guarantee. Safe to
  // default now only because the block predicate keys on "topic not yet
  // consulted" rather than on hit count — the July over-blocking cause — and
  // because `npx memsmith enforcement off` is a non-gated escape hatch.
  it('enforcement is HARD by default (core behavior, not opt-in)', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.MEMSMITH_RETRIEVAL_ENFORCEMENT).toBe('hard');
  });
});
