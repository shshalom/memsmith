// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { estimateTokens, buildCompressionEvent } from '../../src/server/retrieval/compressionMetering.js';

describe('compression metering helper', () => {
  it('estimates tokens as ceil(chars/4)', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(10)).toBe(3);
    expect(estimateTokens(400)).toBe(100);
  });

  it('builds a compression usage event with pre/post/saved', () => {
    const e = buildCompressionEvent('team-1', 'proj-1', 800, 200, 'L1');
    expect(e.kind).toBe('compression');
    expect(e.metadata).toEqual({ preTokens: 200, postTokens: 50, tier: 'L1' });
    expect(e.quantity).toBe(150); // 200 - 50
    expect(e.teamId).toBe('team-1');
    expect(e.projectId).toBe('proj-1');
  });
});
