// SPDX-License-Identifier: Apache-2.0
import type { PostgresQueryable } from '../../storage/postgres/utils.js';

type Scope = { teamId: string; projectId?: string };
const scopeWhere = (s: Scope) => s.projectId
  ? { sql: 'team_id=$1 AND project_id=$2', args: [s.teamId, s.projectId] }
  : { sql: 'team_id=$1', args: [s.teamId] };

export async function lifecycleBoard(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const { rows } = await db.query(`SELECT * FROM observations WHERE ${w.sql} ORDER BY updated_at DESC`, w.args);
  const board: Record<string, any[]> = { open: [], active: [], blocked: [], deferred: [], resolved: [], superseded: [] };
  for (const r of rows) (board[r.lifecycle_state] ??= []).push(r);
  return board;
}
export async function decisionLog(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const { rows } = await db.query(`SELECT * FROM observations WHERE ${w.sql} AND obs_type='decision' ORDER BY created_at DESC`, w.args);
  return rows.map((r: any) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata }));
}
export async function blockedOnWhom(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const { rows } = await db.query(`SELECT * FROM observations WHERE ${w.sql} AND lifecycle_state='blocked'`, w.args);
  const byBlocker: Record<string, any[]> = {};
  for (const r of rows) {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
    const on = meta?.blocked_on ?? 'unknown';
    (byBlocker[on] ??= []).push(r);
  }
  return byBlocker;
}
export async function costPanel(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const { rows } = await db.query(
    `SELECT COALESCE(SUM((metadata->>'discovery_tokens')::bigint),0) AS discovery_tokens FROM observations WHERE ${w.sql}`, w.args);
  const discoveryTokens = Number(rows[0].discovery_tokens);
  const RATE = Number(process.env.CLAUDE_MEM_INPUT_RATE_PER_MTOK ?? 5);
  return { discoveryTokens, distilledTokens: null, estUsd: (discoveryTokens / 1_000_000) * RATE };
}
