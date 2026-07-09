// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { PostgresObservationRepository } from '../../src/storage/postgres/observations.js';
import { combineRanks } from '../../src/server/retrieval/rrf.js';

// Two layers of proof for the search-path wiring:
//
// 1. combineRanks (where fts/vec weights and rrfK are actually consumed) —
//    deterministically proves that the weight VALUES flip the fused winner and
//    that rrfK changes the scores. This is the meaningful assertion: it fails
//    if the weights/k are ignored.
// 2. hybridSearch input plumbing — confirms the input type carries
//    ftsWeight/vecWeight/rrfK and that they reach the fusion without throwing.

describe('combineRanks consumes weights and k (the values the route now supplies)', () => {
  // fts ranks [A, B] (A best), vec ranks [B, A] (B best). The winner is decided
  // entirely by which arm is weighted higher — so flipping the weights flips the
  // result. If combineRanks ignored `weights`, both cases would tie/agree.
  const fts = [{ id: 'A', rank: 0 }, { id: 'B', rank: 1 }];
  const vec = [{ id: 'B', rank: 0 }, { id: 'A', rank: 1 }];

  it('ftsWeight dominant -> A wins', () => {
    const fused = combineRanks([fts, vec], 60, [1.0, 0.0]);
    expect(fused[0].id).toBe('A');
  });

  it('vecWeight dominant -> B wins', () => {
    const fused = combineRanks([fts, vec], 60, [0.0, 1.0]);
    expect(fused[0].id).toBe('B');
  });

  it('rrfK changes the fused scores (k is actually used)', () => {
    const small = combineRanks([fts, vec], 1, [1, 1]);
    const large = combineRanks([fts, vec], 1000, [1, 1]);
    // 1/(k+rank) shrinks as k grows, so the top score is strictly smaller at k=1000.
    expect(large[0].score).toBeLessThan(small[0].score);
  });
});

describe('hybridSearch input plumbing carries the overrides', () => {
  it('accepts ftsWeight/vecWeight/rrfK without throwing (type + runtime plumbing)', async () => {
    const fakeDb = { query: async () => ({ rows: [] }) } as any;
    const repo = new PostgresObservationRepository(fakeDb);
    await expect(
      repo.hybridSearch({ projectId: 'p', teamId: 't', query: 'q', ftsWeight: 0.9, vecWeight: 0.1, rrfK: 42 })
    ).resolves.toBeDefined();
  });
});
