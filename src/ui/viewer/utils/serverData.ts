import { adaptObservations } from './serverAdapter.js';
import type { Observation } from '../types.js';

export const V1_ENDPOINTS = {
  SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream',
  DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions',
  DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost',
  DASH_NOTES: '/dashboard/notes',
} as const;

export async function fetchObservations(
  opts: { query?: string; type?: string; lifecycle?: string; limit?: number; userDirected?: boolean } = {},
): Promise<Observation[]> {
  try {
    const body: Record<string, unknown> = { query: opts.query ?? '', limit: opts.limit ?? 50 };
    if (opts.type) body.obsType = opts.type;
    if (opts.lifecycle) body.lifecycleState = opts.lifecycle;
    if (opts.userDirected) body.userDirected = true;
    const res = await fetch(V1_ENDPOINTS.SEARCH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return adaptObservations(data.observations ?? []);
  } catch { return []; }
}

export async function fetchDashboard(kind: 'board'|'decisions'|'blocked'|'cost'|'metrics'|'spend'|'notes'): Promise<unknown> {
  const map = { board: V1_ENDPOINTS.DASH_BOARD, decisions: V1_ENDPOINTS.DASH_DECISIONS,
    blocked: V1_ENDPOINTS.DASH_BLOCKED, cost: V1_ENDPOINTS.DASH_COST,
    metrics: '/dashboard/metrics', spend: '/dashboard/spend', notes: V1_ENDPOINTS.DASH_NOTES };
  try {
    const res = await fetch(map[kind], { headers: { Accept: 'application/json' } });
    // Distinguish "not authenticated" from "no data". Both used to collapse to
    // null, so an auth failure rendered as "Failed to load dashboard data" and
    // read as a data problem -- which is exactly how this was misdiagnosed once
    // already. Callers that only care about presence still see a falsy result.
    if (res.status === 401 || res.status === 403) return DASHBOARD_UNAUTHORIZED;
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Sentinel for an authentication failure, distinct from null ("no data").
export const DASHBOARD_UNAUTHORIZED = Symbol.for('memsmith.dashboard.unauthorized');

export function isUnauthorized(v: unknown): boolean {
  return v === DASHBOARD_UNAUTHORIZED;
}
