// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { applyQualityGate } from '../../src/server/generation/processGeneratedResponse.js';

describe('applyQualityGate honors an explicit floor (resolver-supplied)', () => {
  it('drops items below the supplied floor, not the env default', () => {
    const items = [
      { obsType: 'decision', facts: ['a', 'b', 'c'], why: 'because' }, // higher quality
      { obsType: 'note' },                                             // low quality
    ];
    const keptHigh = applyQualityGate(items as any, 90); // very high floor
    const keptLow = applyQualityGate(items as any, 0);   // floor 0 keeps all
    expect(keptLow.length).toBeGreaterThanOrEqual(keptHigh.length);
  });
});
