// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Application, RequestHandler } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PoolRegistry } from '../../storage/postgres/pool-registry.js';
import { resolveRequestDatabase } from '../middleware/resolve-request-database.js';
import { getPackageRoot } from '../../shared/paths.js';
import { lifecycleBoard, decisionLog, blockedOnWhom, costPanel, metricsOverview, userNotes } from './queries.js';
import { getSpendReport } from './spend.js';

// Resolve ui.html via getPackageRoot() (bundle-safe) rather than
// `new URL(import.meta.url)`, which is undefined once esbuild bundles this into
// the CJS server-service and throws ERR_INVALID_URL at module load. Mirrors
// ServerViewerRoutes' candidate-path approach; source layout and the bundled
// plugin layout are both covered.
const UI_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  return [
    path.join(packageRoot, 'src', 'server', 'dashboard', 'ui.html'),
    path.join(packageRoot, 'server', 'dashboard', 'ui.html'),
    path.join(packageRoot, 'dashboard', 'ui.html'),
    path.join(packageRoot, 'ui', 'dashboard.html'),
  ];
})();

const UI_HTML_PATH: string | null =
  UI_HTML_CANDIDATE_PATHS.find(candidate => existsSync(candidate)) ?? null;

const uiHtmlBytes: Buffer | null = UI_HTML_PATH ? readFileSync(UI_HTML_PATH) : null;

// Wraps an async Express handler and forwards thrown errors to next().
function asyncHandler(
  fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Register the five dashboard routes on `app`.
 *
 * `mw` is an optional array of middleware inserted before each data route.
 * The DashboardRoutes class passes readAuth here; the unit-test fake-app path
 * passes nothing (the default empty array) so the test never needs a real
 * Postgres pool.
 *
 * `db` is the ACCOUNT-table connection (used for costPanel's usage_events
 * half and as the fallback DATA connection when resolveDataDb is absent).
 * `resolveDataDb` (Task 5), when provided, resolves the per-request DATA
 * connection (observations, etc.) from req.authContext.projectId via the
 * PoolRegistry — mirroring resolveRequestDatabase's routing rule exactly
 * (buildScope itself is NEVER involved in choosing a database; it only
 * filters rows). Omitted by every existing caller/test, which keeps them on
 * the single `db` connection exactly as before this task.
 */
export function registerDashboardRoutes(
  app: Application,
  db: PostgresQueryable,
  mw: RequestHandler[] = [],
  resolver?: { inputRatePerMtok(teamId: string): Promise<number>; provider(teamId: string): Promise<string> },
  resolveDataDb?: (req: Parameters<RequestHandler>[0]) => PostgresQueryable,
): void {
  const dataDbFor = (req: Parameters<RequestHandler>[0]): PostgresQueryable =>
    resolveDataDb ? resolveDataDb(req) : db;
  // GET /dashboard — serve the self-contained team dashboard UI.
  app.get('/dashboard', (_req, res) => {
    if (!uiHtmlBytes) {
      res.status(503).json({ error: 'UIUnavailable', message: 'Dashboard UI not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(uiHtmlBytes);
  });

  // GET /dashboard/board — lifecycle kanban grouped by state.
  app.get('/dashboard/board', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const board = await lifecycleBoard(dataDbFor(req), scope);
    res.status(200).json(board);
  }));

  // GET /dashboard/decisions — decision log (obs_type='decision').
  app.get('/dashboard/decisions', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const decisions = await decisionLog(dataDbFor(req), scope);
    res.status(200).json(decisions);
  }));

  // GET /dashboard/blocked — observations grouped by blocked_on metadata key.
  app.get('/dashboard/blocked', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const blocked = await blockedOnWhom(dataDbFor(req), scope);
    res.status(200).json(blocked);
  }));

  // GET /dashboard/cost — token usage and estimated USD cost for the team.
  // costPanel spans both classes of table (see the Task 5 comment on
  // costPanel itself): `db` (account/base) covers usage_events, `dataDbFor`
  // covers the observations-derived discoveryTokens figure.
  app.get('/dashboard/cost', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const cost = await costPanel(dataDbFor(req), scope, resolver, db);
    res.status(200).json(cost);
  }));

  // GET /dashboard/metrics — single real-data overview for the redesigned
  // dashboard (totals, type composition, work parked-vs-completed, a short
  // needs-attention list, capture activity). Replaces the all-observations
  // lifecycle kanban, which was noise at scale.
  app.get('/dashboard/metrics', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const metrics = await metricsOverview(dataDbFor(req), scope);
    res.status(200).json(metrics);
  }));

  // GET /dashboard/notes — user-directed notes (kind='user_note').
  app.get('/dashboard/notes', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const notes = await userNotes(dataDbFor(req), scope);
    res.status(200).json({ notes });
  }));

  // GET /dashboard/spend — real AI-coding spend for THIS project, read from
  // ccusage (parses local Claude Code / Codex usage logs). This is the honest
  // "what your coding agents actually cost" baseline the memory-savings story
  // is measured against. Best-effort: returns { available:false } if ccusage
  // can't run. Cached ~5min inside getSpendReport.
  app.get('/dashboard/spend', ...mw, asyncHandler(async (_req, res) => {
    const report = await getSpendReport(Date.now());
    res.status(200).json(report);
  }));
}

// Extract { teamId, projectId? } from query params, falling back to
// req.authContext when query params are absent. An explicit query param always
// wins (override). Returns null only if both query and authContext lack teamId.
function buildScope(req: Parameters<RequestHandler>[0]): { teamId: string; projectId?: string } | null {
  const queryTeamId = typeof req.query.teamId === 'string' ? req.query.teamId.trim() : '';
  const queryProjectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  // Explicit query param takes precedence; fall back to authContext.
  const teamId = queryTeamId || req.authContext?.teamId || '';
  if (!teamId) return null;
  const projectId = queryProjectId || req.authContext?.projectId || undefined;
  return projectId ? { teamId, projectId } : { teamId };
}

export interface DashboardRoutesOptions {
  db: PostgresPool;
  authMode?: string;
  allowLocalDevBypass?: boolean;
  // Local-dev fallback team for unauthenticated loopback requests. Only
  // applied when authMode === 'local-dev' AND allowLocalDevBypass AND the
  // request is loopback — the middleware guards enforce all three conditions.
  localDevTeamId?: string | null;
  localDevProjectId?: string | null;
  settingsResolver?: { inputRatePerMtok(teamId: string): Promise<number>; provider(teamId: string): Promise<string> };
  // Task 5 — per-request database routing. Optional: when absent,
  // resolveRequestDatabase is never mounted and every dashboard data query
  // stays on `db` exactly as before this task (see registerDashboardRoutes'
  // resolveDataDb doc).
  poolRegistry?: PoolRegistry;
  baseDatabaseName?: string;
  baseProjectId?: string | null;
  /**
   * Forwards a JOINED project's reads to its team server. Optional: omitting it
   * leaves every dashboard read local, exactly as before.
   */
  teamReadProxy?: RequestHandler;
}

/**
 * RouteHandler-compatible class for integration with server.registerRoutes().
 * Constructor takes a Postgres pool; setupRoutes builds readAuth from it and
 * wires it into registerDashboardRoutes.
 */
export class DashboardRoutes implements RouteHandler {
  constructor(private readonly options: DashboardRoutesOptions) {}

  setupRoutes(app: Application): void {
    // TEAM READS GO TO THE TEAM. Mounted BEFORE readAuth, deliberately: a joined
    // project's request carries a team-issued credential this server cannot
    // validate (its api_keys table has no such row), so forwarding must happen
    // before anything tries to authenticate it locally. Verified live:
    // /dashboard/metrics with a team key -> 403 here, 200 against the team.
    //
    // Everything that is not a joined team project falls through untouched.
    if (this.options.teamReadProxy) {
      app.use('/dashboard', this.options.teamReadProxy);
    }
    const readAuth = requirePostgresServerAuth(this.options.db, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId,
      localDevProjectId: this.options.localDevProjectId,
      requiredScopes: ['memories:read'],
    });
    // Task 5 — mount resolveRequestDatabase AFTER readAuth (which populates
    // req.authContext) and BEFORE the data routes, mirroring
    // ServerV1PostgresRoutes' dbRouting. Only when a registry was actually
    // constructed; buildScope itself never chooses a database (row filtering
    // only — see its own doc comment and the SECURITY invariant in
    // resolve-request-database.ts).
    const mw: RequestHandler[] = this.options.poolRegistry
      ? [readAuth, resolveRequestDatabase(this.options.poolRegistry, {
          baseDatabaseName: this.options.baseDatabaseName ?? 'postgres',
          baseProjectId: this.options.baseProjectId ?? null,
        })]
      : [readAuth];
    const resolveDataDb = this.options.poolRegistry
      ? (req: Parameters<RequestHandler>[0]) => req.databasePool ?? this.options.db
      : undefined;
    registerDashboardRoutes(app, this.options.db, mw, this.options.settingsResolver, resolveDataDb);
  }
}
