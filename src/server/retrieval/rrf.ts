// SPDX-License-Identifier: Apache-2.0
// RRF fusion, adapted from agentmemory/src/state/hybrid-search.ts (Apache-2.0).
export type RankedList = { id: string; rank: number }[];
export type FusedResult = { id: string; score: number };

const DEFAULT_K = Number(process.env.MEMSMITH_RRF_K ?? 60);

export function combineRanks(rankings: RankedList[], k: number = DEFAULT_K, weights?: number[]): FusedResult[] {
  const scores = new Map<string, number>();
  rankings.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    for (const { id, rank } of list) {
      scores.set(id, (scores.get(id) ?? 0) + w * (1 / (k + rank)));
    }
  });
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
