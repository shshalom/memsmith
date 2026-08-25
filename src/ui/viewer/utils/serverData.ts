import { adaptObservations } from './serverAdapter.js';
import { apiUrl } from './projectScope.js';
import type { Observation } from '../types.js';

export const V1_ENDPOINTS = {
  SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream',
  DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions',
  DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost',
  DASH_NOTES: '/dashboard/notes', PROJECTS: '/v1/projects',
} as const;

export interface ProjectSummary {
  projectId: string;
  teamId: string;
  name: string;
  runtime: 'local' | 'team';
  isCurrent: boolean;
}

// GET /v1/projects is loopback-gated and may not exist on every server build
// (older servers, or a non-loopback client). Any non-2xx or network failure
// degrades to an empty list so the switcher can render nothing rather than
// error — that degradation is required behaviour, not a stopgap.
export async function fetchProjects(): Promise<ProjectSummary[]> {
  try {
    const res = await fetch(apiUrl(V1_ENDPOINTS.PROJECTS), { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data as ProjectSummary[] : [];
  } catch {
    return [];
  }
}

export async function fetchObservations(
  opts: { query?: string; type?: string; lifecycle?: string; limit?: number; userDirected?: boolean } = {},
): Promise<Observation[]> {
  try {
    const body: Record<string, unknown> = { query: opts.query ?? '', limit: opts.limit ?? 50 };
    if (opts.type) body.obsType = opts.type;
    if (opts.lifecycle) body.lifecycleState = opts.lifecycle;
    if (opts.userDirected) body.userDirected = true;
    // Same two omissions fetchDashboard had: no cookie and no project. Without
    // credentials the request is unauthenticated; without the project it is
    // unscoped, so a joined project's Observations tab came back empty while the
    // metrics tile showed the team's 14 rows.
    const res = await fetch(apiUrl(V1_ENDPOINTS.SEARCH), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    // CARRY THE PROJECT AND THE CREDENTIAL. This sent neither.
    //
    // Without `credentials: 'include'` the browser attaches no cookie, so every
    // dashboard call 401s and the UI renders "Not authenticated — reload this
    // page to sign in" no matter what the server does. fetchIdentity already
    // does this and its comment says it is REQUIRED; these calls were simply
    // never given the same treatment, so /v1/identity worked while every panel
    // failed.
    //
    // Without the project param the request is unscoped, so the server answers
    // for whatever the cookie names — which is how a scoped dashboard silently
    // showed a different project's data. fetchIdentity forwards it as
    // `projectId`; match that exactly so the two cannot disagree about which
    // project the page is displaying.
    const res = await fetch(apiUrl(map[kind]), {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
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

// Collapse the sentinel back to null for callers that only want data. The
// sentinel is a Symbol and therefore TRUTHY, so a plain `?? null` would pass it
// through into state. Every consumer that does not explicitly branch on
// isUnauthorized must route its value through this.
export function dataOrNull(v: unknown): unknown {
  return isUnauthorized(v) ? null : v;
}
