// tests/retrieval/directive.test.ts
import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE, frameMemory, frameGapNote } from '../../src/services/retrieval/directive.js';

describe('directive + framing', () => {
  it('directive names MemSmith memory as the FIRST source for why/decision questions', () => {
    expect(MEMORY_FIRST_DIRECTIVE).toContain('MemSmith');
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).toContain('first');
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).toMatch(/why|decision|rationale/);
    // MemSmith-native: must NOT reference claude-mem
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).not.toContain('claude-mem');
  });
  it('frameMemory tags provenance (obs_type + captured date + id) and marks verifiable', () => {
    const out = frameMemory([{ id: 'obs-1', content: 'We chose X because Y', obsType: 'decision', capturedAt: '2026-07-13T00:00:00Z' }]);
    expect(out).toContain('We chose X because Y');
    expect(out).toContain('decision');
    expect(out).toContain('2026-07-13');
    expect(out.toLowerCase()).toMatch(/verif/); // authoritative-but-verifiable framing present
  });
  it('frameMemory returns empty string for no memories', () => {
    expect(frameMemory([])).toBe('');
  });
  it('gap note flags missing rationale and says it will proceed to files', () => {
    expect(frameGapNote().toLowerCase()).toContain('no memsmith memory');
  });
});
