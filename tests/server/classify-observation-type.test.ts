// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { resolveObsType } from '../../src/server/runtime/import/classifyObservationType.js';

const CANON = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision', 'security_alert', 'security_note'];
const never = { classify: async () => { throw new Error('should not be called'); } };

describe('resolveObsType', () => {
  it('keeps a source type that is already canonical (no model call)', async () => {
    const t = await resolveObsType({ content: 'x', sourceType: 'decision', canonical: CANON, classifier: never });
    expect(t).toBe('decision');
  });
  it('classifies an unknown source type via the model', async () => {
    const classifier = { classify: async () => 'feature' };
    const t = await resolveObsType({ content: 'added a thing', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('feature');
  });
  it('falls back to change when the model returns an invalid label', async () => {
    const classifier = { classify: async () => 'nonsense-type' };
    const t = await resolveObsType({ content: 'x', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('change');
  });
  it('falls back to change when the model errors or returns null', async () => {
    const classifier = { classify: async () => null };
    const t = await resolveObsType({ content: 'x', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('change');
  });
  it('falls back to change when the model throws for a non-canonical type', async () => {
    const classifier = { classify: async () => { throw new Error('ollama unreachable'); } };
    const t = await resolveObsType({ content: 'x', sourceType: 'note', canonical: CANON, classifier });
    expect(t).toBe('change');
  });
});
