// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { RECORD_INTENT_DIRECTIVE } from '../../src/services/retrieval/directive.js';

describe('RECORD_INTENT_DIRECTIVE', () => {
  it('names the record verbs and the enforced write', () => {
    const t = RECORD_INTENT_DIRECTIVE.toLowerCase();
    expect(t).toMatch(/remember|record|log|park|mark|save/);
    expect(t).toContain('note_add');
    expect(t).not.toContain('observation_add');
  });
  it('instructs self-contained composition + confirmation + surface-on-failure', () => {
    const t = RECORD_INTENT_DIRECTIVE.toLowerCase();
    expect(t).toMatch(/self-contained|standalone|compose/);
    expect(t).toMatch(/confirm|recorded/);
    expect(t).toMatch(/fail|couldn't|could not|surface/);
  });
  it('is MemSmith-native (no claude-mem)', () => {
    expect(RECORD_INTENT_DIRECTIVE.toLowerCase()).not.toContain('claude-mem');
  });
  it('names the note_add tool and does not ask the agent to set kind/metadata', () => {
    expect(RECORD_INTENT_DIRECTIVE).toContain('note_add');
    expect(RECORD_INTENT_DIRECTIVE).not.toContain('observation_add');
    expect(RECORD_INTENT_DIRECTIVE).not.toContain('kind:"user_note"');
    expect(RECORD_INTENT_DIRECTIVE).not.toContain('metadata.userDirected');
  });
});
