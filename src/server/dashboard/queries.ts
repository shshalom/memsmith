// SPDX-License-Identifier: Apache-2.0
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { resolveHeads } from '../retrieval/supersession.js';

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
  const { rows } = await db.query(`SELECT * FROM observations WHERE ${w.sql} AND obs_type='decision' ORDER BY created_at ASC`, w.args);
  const parse = (r: any) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata });
  const rowsById = new Map<string, any>(rows.map((r: any) => [r.id, parse(r)]));
  const heads = await resolveHeads(db, rows.map((r: any) => r.id), s);
  const chains = new Map<string, any[]>();
  for (const r of rows) { const h = heads.get(r.id)!; (chains.get(h) ?? chains.set(h, []).get(h)!).push(rowsById.get(r.id)); }
  const out = [];
  for (const [headId, members] of chains) {
    let head = rowsById.get(headId);
    let history: any[];
    if (head) {
      // Happy path: the chain head is itself a decision row.
      history = members.filter((m: any) => m.id !== headId); // rows already created_at ASC
    } else {
      // The chain head is a non-decision observation (not in rowsById).
      // Fall back to the newest decision member (last in ASC-ordered list).
      if (members.length === 0) continue;
      head = members[members.length - 1];
      history = members.slice(0, members.length - 1); // all but the chosen head, oldest→newest
    }
    out.push({ head, history });
  }
  out.sort((a, b) => new Date(b.head.created_at).getTime() - new Date(a.head.created_at).getTime());
  return out;
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
export async function costPanel(db: PostgresQueryable, s: Scope, resolver?: {
  inputRatePerMtok(teamId: string): Promise<number>;
  provider(teamId: string): Promise<string>;
}) {
  const w = scopeWhere(s);
  const comp = await db.query(
    `SELECT COALESCE(SUM(quantity),0) AS saved,
            COALESCE(SUM((metadata->>'preTokens')::bigint),0) AS pre
       FROM usage_events
      WHERE ${w.sql} AND kind = 'compression'`, w.args);
  const savedTokens = Number(comp.rows[0].saved);
  const preTokens = Number(comp.rows[0].pre);
  const pctSmaller = preTokens > 0 ? savedTokens / preTokens : 0;
  const rate = resolver ? await resolver.inputRatePerMtok(s.teamId) : Number(process.env.MEMSMITH_INPUT_RATE_PER_MTOK ?? 5);
  const estUsdSaved = (savedTokens / 1_000_000) * rate;
  const activeProvider = resolver ? await resolver.provider(s.teamId) : (process.env.MEMSMITH_SERVER_PROVIDER ?? 'ollama').toLowerCase();
  const localGeneration = activeProvider === 'ollama';
  // discovery_tokens retained for back-compat with the existing dashboard strip.
  const disc = await db.query(
    `SELECT COALESCE(SUM((metadata->>'discovery_tokens')::bigint),0) AS discovery_tokens FROM observations WHERE ${w.sql}`, w.args);
  return { savedTokens, preTokens, pctSmaller, estUsdSaved, activeProvider, localGeneration, discoveryTokens: Number(disc.rows[0].discovery_tokens) };
}
