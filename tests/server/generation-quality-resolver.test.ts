// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { applyQualityGate } from '../../src/server/generation/processGeneratedResponse.js';

describe('applyQualityGate honors an explicit floor (resolver-supplied)', () => {
  it('the floor value gates which items survive (decision scores 45, note scores 0)', () => {
    const items = [
      { obsType: 'decision', facts: ['a', 'b', 'c'], why: 'because' }, // quality 45
      { obsType: 'note' },                                             // quality 0
    ];
    // floor 0 keeps both; floor 40 drops only the note; floor 90 drops both.
    // The strictly-decreasing counts prove the floor argument is actually applied
    // (a tautological `>=` would pass even if the floor were ignored).
    expect(applyQualityGate(items as any, 0).length).toBe(2);
    expect(applyQualityGate(items as any, 40).length).toBe(1);
    expect(applyQualityGate(items as any, 90).length).toBe(0);
  });
});
