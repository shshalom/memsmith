// SPDX-License-Identifier: Apache-2.0
//
// Supersession-chain read. The `supersedes` column points backward (a newer row
// names the older row it replaced), so finding the CURRENT decision from an old
// one means walking FORWARD: repeatedly ask "who supersedes the one I hold?".
// Scoped so a chain never crosses a team/project boundary; bounded by a depth cap
// and a visited-set so a malformed cycle can never hang the walk.
import type { PostgresQueryable } from '../../storage/postgres/utils.js';

export type SupersedeScope = { teamId: string; projectId?: string };

const DEFAULT_MAX_DEPTH = 16;
export function maxChainDepth(): number {
  const raw = Number(process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH ?? DEFAULT_MAX_DEPTH);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_DEPTH;
  return Math.max(1, Math.min(256, Math.trunc(raw)));
}

// One step forward: the newest row that supersedes `id`, within scope. null = head.
async function successorOf(db: PostgresQueryable, id: string, scope: SupersedeScope): Promise<string | null> {
  const args: unknown[] = [id, scope.teamId];
  let projClause = '';
  if (scope.projectId) { projClause = ' AND project_id = $3'; args.push(scope.projectId); }
  const { rows } = await db.query(
    `SELECT id FROM observations
      WHERE supersedes = $1 AND team_id = $2${projClause}
      ORDER BY created_at DESC LIMIT 1`,
    args,
  );
  return rows.length ? String(rows[0].id) : null;
}

export async function resolveSupersessionHead(
  db: PostgresQueryable, startId: string, scope: SupersedeScope,
): Promise<string> {
  let current = startId;
  const visited = new Set<string>([startId]);
  const cap = maxChainDepth();
  for (let depth = 0; depth < cap; depth++) {
    const next = await successorOf(db, current, scope);
    if (next === null) break;
    if (visited.has(next)) { // cycle
      // eslint-disable-next-line no-console
      console.warn(`[supersession] cycle detected walking from ${startId} at ${next}`);
      break;
    }
    visited.add(next);
    current = next;
  }
  return current;
}

// Batch: resolve many ids, memoizing so shared tails are walked once.
export async function resolveHeads(
  db: PostgresQueryable, ids: string[], scope: SupersedeScope,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const memo = new Map<string, string>(); // id seen mid-walk -> its head
  for (const id of ids) {
    if (out.has(id)) continue;
    if (memo.has(id)) { out.set(id, memo.get(id)!); continue; }
    // walk, recording the path so every node on it maps to the same head
    const path: string[] = [id];
    let current = id;
    const visited = new Set<string>([id]);
    const cap = maxChainDepth();
    let hitMemo: string | null = null;
    for (let depth = 0; depth < cap; depth++) {
      if (memo.has(current)) { hitMemo = memo.get(current)!; break; }
      const next = await successorOf(db, current, scope);
      if (next === null) break;
      if (visited.has(next)) { console.warn(`[supersession] cycle detected walking from ${id} at ${next}`); break; }
      visited.add(next); path.push(next); current = next;
    }
    const head = hitMemo ?? current;
    for (const node of path) { memo.set(node, head); }
    out.set(id, head);
  }
  return out;
}
