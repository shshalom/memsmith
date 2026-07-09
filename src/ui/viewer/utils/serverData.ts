import { adaptObservations } from './serverAdapter.js';
import type { Observation } from '../types.js';

export const V1_ENDPOINTS = {
  SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream',
  DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions',
  DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost',
} as const;

export async function fetchObservations(
  opts: { query?: string; type?: string; lifecycle?: string; limit?: number } = {},
): Promise<Observation[]> {
  try {
    const body: Record<string, unknown> = { query: opts.query ?? '', limit: opts.limit ?? 50 };
    if (opts.type) body.obsType = opts.type;
    if (opts.lifecycle) body.lifecycleState = opts.lifecycle;
    const res = await fetch(V1_ENDPOINTS.SEARCH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return adaptObservations(data.observations ?? []);
  } catch { return []; }
}

export async function fetchDashboard(kind: 'board'|'decisions'|'blocked'|'cost'): Promise<unknown> {
  const map = { board: V1_ENDPOINTS.DASH_BOARD, decisions: V1_ENDPOINTS.DASH_DECISIONS,
    blocked: V1_ENDPOINTS.DASH_BLOCKED, cost: V1_ENDPOINTS.DASH_COST };
  try {
    const res = await fetch(map[kind], { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
