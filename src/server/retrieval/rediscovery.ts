// SPDX-License-Identifier: Apache-2.0
export interface RediscoveryDeps {
  hybridSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>;
}
export async function detectRediscovery(
  deps: RediscoveryDeps,
  input: { projectId: string; teamId: string; toolQuery: string; toolResult: string }
): Promise<{ rediscovered: boolean; matchedIds: string[] }> {
  if (!input.toolQuery.trim()) return { rediscovered: false, matchedIds: [] };
  const hits = await deps.hybridSearch({ projectId: input.projectId, teamId: input.teamId, query: input.toolQuery, limit: 3 });
  const matchedIds = hits.map(h => h.id);
  return { rediscovered: matchedIds.length > 0, matchedIds };
}
