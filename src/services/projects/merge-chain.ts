// SPDX-License-Identifier: Apache-2.0
//
// Where a project archived by `memsmith merge` now lives. Kept free of other
// imports: the server's request routing and the hooks' identity step both use it.

export const MAX_MERGE_HOPS = 8;

export type MergeChain =
  | { kind: 'active' }
  | { kind: 'redirect'; projectId: string; teamId: string; via: string[] }
  | { kind: 'broken'; reason: string; via: string[] };

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export async function resolveMergeChain(pool: Queryable, projectId: string): Promise<MergeChain> {
  const via: string[] = [];
  let current = projectId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    const result = await pool.query(
      `SELECT team_id, metadata->>'mergedInto' AS merged_into FROM projects WHERE id = $1`,
      [current],
    );
    const row = result.rows[0] as { team_id?: unknown; merged_into?: unknown } | undefined;
    if (!row) {
      return via.length === 0
        ? { kind: 'active' }
        : { kind: 'broken', reason: `project ${current}, which ${via[via.length - 1]} was merged into, is gone`, via };
    }
    const next = typeof row.merged_into === 'string' && row.merged_into ? row.merged_into : null;
    if (!next) {
      return via.length === 0 ? { kind: 'active' } : { kind: 'redirect', projectId: current, teamId: String(row.team_id), via };
    }
    via.push(current);
    if (via.includes(next)) return { kind: 'broken', reason: `merges form a cycle: ${[...via, next].join(' -> ')}`, via };
    current = next;
  }
  return { kind: 'broken', reason: `more than ${MAX_MERGE_HOPS} merges in a row from ${projectId}`, via };
}
