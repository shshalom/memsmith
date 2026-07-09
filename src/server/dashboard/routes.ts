// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Application, RequestHandler } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getPackageRoot } from '../../shared/paths.js';
import { lifecycleBoard, decisionLog, blockedOnWhom, costPanel } from './queries.js';

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
 */
export function registerDashboardRoutes(
  app: Application,
  db: PostgresQueryable,
  mw: RequestHandler[] = [],
): void {
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
    const board = await lifecycleBoard(db, scope);
    res.status(200).json(board);
  }));

  // GET /dashboard/decisions — decision log (obs_type='decision').
  app.get('/dashboard/decisions', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const decisions = await decisionLog(db, scope);
    res.status(200).json(decisions);
  }));

  // GET /dashboard/blocked — observations grouped by blocked_on metadata key.
  app.get('/dashboard/blocked', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const blocked = await blockedOnWhom(db, scope);
    res.status(200).json(blocked);
  }));

  // GET /dashboard/cost — token usage and estimated USD cost for the team.
  app.get('/dashboard/cost', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);
    if (!scope) { res.status(400).json({ error: 'ValidationError', message: 'teamId is required' }); return; }
    const cost = await costPanel(db, scope);
    res.status(200).json(cost);
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
}

/**
 * RouteHandler-compatible class for integration with server.registerRoutes().
 * Constructor takes a Postgres pool; setupRoutes builds readAuth from it and
 * wires it into registerDashboardRoutes.
 */
export class DashboardRoutes implements RouteHandler {
  constructor(private readonly options: DashboardRoutesOptions) {}

  setupRoutes(app: Application): void {
    const readAuth = requirePostgresServerAuth(this.options.db, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId,
      requiredScopes: ['memories:read'],
    });
    registerDashboardRoutes(app, this.options.db, [readAuth]);
  }
}
