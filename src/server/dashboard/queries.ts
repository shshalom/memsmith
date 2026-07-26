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

// The trackable-work observation types — the ones that represent actual work
// items worth surfacing on a dashboard, as opposed to `discovery` (which is
// point-in-time "the agent looked at X" logging noise, the bulk of the corpus).
const WORK_TYPES = ['decision', 'feature', 'bugfix', 'refactor', 'change', 'security_alert', 'security_note'];

// Single overview payload for the redesigned dashboard. Every number here is a
// real aggregate over the observations table — no invented/placeholder metrics.
export async function metricsOverview(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const one = async (sql: string) => (await db.query(sql, w.args)).rows;

  const total = Number((await one(`SELECT count(*)::int n FROM observations WHERE ${w.sql}`))[0].n);
  const embedded = Number((await one(`SELECT count(*)::int n FROM observations WHERE ${w.sql} AND embedding_vec IS NOT NULL`))[0].n);

  const byType = (await one(
    `SELECT obs_type, count(*)::int n FROM observations WHERE ${w.sql} GROUP BY obs_type ORDER BY n DESC`,
  )).map((r: any) => ({ type: r.obs_type ?? 'unknown', count: Number(r.n) }));

  // Completed (resolved+superseded) vs in-flight (active) vs parked (deferred)
  // vs blocked vs open — over TRACKABLE work types only, so the ratio is real
  // work, not logging noise. This drives the parked-vs-completed chart.
  const workRows = await one(
    `SELECT lifecycle_state, count(*)::int n
       FROM observations
      WHERE ${w.sql} AND obs_type = ANY('{${WORK_TYPES.join(',')}}')
      GROUP BY lifecycle_state`,
  );
  const work: Record<string, number> = { open: 0, active: 0, blocked: 0, deferred: 0, resolved: 0, superseded: 0 };
  for (const r of workRows) work[r.lifecycle_state] = Number(r.n);

  // Needs-attention: only signals we can TRUST. Retroactive lifecycle labels
  // and content keyword-matching both produce mostly false positives on
  // historical narration ("blocked" past events; observations that merely
  // *mention* the word TODO). The genuinely reliable, actionable signals are:
  //   1. security_alert / security_note — always worth surfacing.
  //   2. deferred decisions — structured (type+lifecycle) parked work; the one
  //      lifecycle signal that's meaningful because deferral is a deliberate,
  //      still-relevant state ("postponing X until Y").
  // A short, correct list beats a long, noisy one. If nothing qualifies, the
  // panel honestly shows "all clear".
  const attention = (await one(
    `SELECT id, obs_type, lifecycle_state, content, created_at,
            CASE
              WHEN obs_type = 'security_alert' THEN 0
              WHEN obs_type = 'security_note' THEN 1
              WHEN lifecycle_state = 'deferred' AND obs_type = 'decision' THEN 2
              ELSE 9
            END AS rank
       FROM observations
      WHERE ${w.sql}
        AND (
          obs_type IN ('security_alert','security_note')
          OR (lifecycle_state = 'deferred' AND obs_type = 'decision')
        )
      ORDER BY rank ASC, created_at DESC
      LIMIT 25`,
  )).map((r: any) => {
    const rank = Number(r.rank);
    const reason =
      rank === 0 ? 'security alert' :
      rank === 1 ? 'security note' :
      rank === 2 ? 'parked decision' : 'attention';
    return {
      id: r.id,
      type: r.obs_type,
      lifecycle: r.lifecycle_state,
      reason,
      title: firstLineOf(r.content),
      // Full content so the card can expand to show the whole observation.
      content: typeof r.content === 'string' ? r.content : '',
      createdAt: r.created_at,
    };
  });

  // Capture activity per day (last 30 days that have data).
  const activity = (await one(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*)::int n
       FROM observations WHERE ${w.sql}
      GROUP BY day ORDER BY day DESC LIMIT 30`,
  )).map((r: any) => ({ day: r.day, count: Number(r.n) })).reverse();

  const decisions = Number((await one(
    `SELECT count(*)::int n FROM observations WHERE ${w.sql} AND obs_type = 'decision'`,
  ))[0].n);

  return {
    total,
    embedded,
    embeddedPct: total > 0 ? embedded / total : 0,
    decisions,
    byType,
    work,
    attention,
    activity,
  };
}

function firstLineOf(content: unknown): string {
  const s = typeof content === 'string' ? content : '';
  const line = (s.split('\n')[0] ?? '').trim();
  return line.length > 120 ? line.slice(0, 120).trimEnd() + '…' : line;
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
export async function userNotes(db: PostgresQueryable, scope: Scope): Promise<Array<{ id: string; content: string; created_at: string; obs_type: string | null; lifecycle_state: string | null }>> {
  const w = scopeWhere(scope);
  const { rows } = await db.query(
    `SELECT id, content, created_at, obs_type, lifecycle_state
       FROM observations WHERE ${w.sql} AND kind = 'user_note'
       ORDER BY created_at DESC LIMIT 100`, w.args);
  return rows as any;
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
// Task 5 — costPanel spans BOTH classes of table: usage_events is an ACCOUNT
// table (bootstrapped only in the base database's ACCOUNT_SCHEMA_SQL — a
// per-project database has no usage_events table at all) while observations
// is per-project DATA. `db` (the DATA-table connection, resolved via the
// per-request pool registry) is the default for both params for backward
// compatibility with existing callers/tests that pass a single connection;
// production wiring (DashboardRoutes) passes `accountDb` explicitly as the
// base pool so the usage_events query never 42P01s against a fresh project DB.
export async function costPanel(db: PostgresQueryable, s: Scope, resolver?: {
  inputRatePerMtok(teamId: string): Promise<number>;
  provider(teamId: string): Promise<string>;
}, accountDb: PostgresQueryable = db) {
  const w = scopeWhere(s);
  const comp = await accountDb.query(
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
