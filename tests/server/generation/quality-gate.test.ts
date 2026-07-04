// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { applyQualityGate } from '../../../src/server/generation/processGeneratedResponse.js';

describe('applyQualityGate', () => {
  it('keeps observations at or above the floor and stamps quality', () => {
    const kept = applyQualityGate(
      [{ obsType: 'decision', title: 'Chose PG', facts: ['a', 'b', 'c'], narrative: 'x'.repeat(60), concepts: ['s'] }],
      20
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].quality).toBeGreaterThanOrEqual(20);
  });

  it('drops observations below the floor', () => {
    const kept = applyQualityGate([{ narrative: 'ok' }], 20);
    expect(kept).toHaveLength(0);
  });
});
