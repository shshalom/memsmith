// SPDX-License-Identifier: Apache-2.0
//
// Forward a joined project's dashboard reads to its TEAM server.
//
// See team-read-proxy.ts for why this exists. In short: after a join the data is
// on the team server, the dashboard only calls localhost, and the local server
// cannot validate a team-issued key — so a joined project showed
// "Not authenticated" and no data despite the join having succeeded.
//
// Mounted BEFORE the local auth middleware, deliberately. A joined project's
// request carries a team credential the local server would reject, so it must be
// forwarded before anything tries to authenticate it locally. Requests that are
// not for a joined team project fall straight through to next() and the existing
// local path handles them exactly as before.
//
// READS ONLY. Writes still go through the normal hook path (which already
// targets the team server via buildServerContext), so this cannot become an
// unaudited write channel.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../../utils/logger.js';
import { resolveTeamProxyTarget, type TeamProxyMarker } from './team-read-proxy.js';

export interface TeamReadProxyDeps {
  /** Marker for a project id, resolved via its recorded path. Null when unknown. */
  lookupMarker: (projectId: string) => Promise<TeamProxyMarker | null>;
  /** Cached key for a team, or null. */
  resolveTeamKey: (teamId: string) => string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Express middleware. Never throws: a proxy failure logs and falls through to
 * the local path rather than 500ing the dashboard.
 */
export function teamReadProxy(deps: TeamReadProxyDeps): RequestHandler {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (req: Request, res: Response, next: NextFunction) => {
    // GET only. A write must not be silently re-homed to another server.
    if (req.method !== 'GET') return next();

    const q = req.query as Record<string, unknown> | undefined;
    const projectId = typeof q?.projectId === 'string' ? q.projectId
      : typeof q?.project === 'string' ? q.project
      : '';
    if (!projectId.trim()) return next();

    let target: ReturnType<typeof resolveTeamProxyTarget> = null;
    try {
      const marker = await deps.lookupMarker(projectId);
      // originalUrl, NOT req.path. Mounted with app.use('/dashboard', …), Express
      // strips the mount prefix from req.path — so this forwarded '/metrics'
      // instead of '/dashboard/metrics' and the team server answered
      // "Cannot GET /metrics". originalUrl keeps the full path the client asked
      // for, which is exactly what the upstream expects.
      const qIndex = req.originalUrl.indexOf('?');
      const fullPath = qIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, qIndex);
      target = resolveTeamProxyTarget({
        marker,
        teamKey: marker ? deps.resolveTeamKey(marker.teamId) : null,
        path: fullPath,
        search: qIndex === -1 ? '' : req.originalUrl.slice(qIndex),
      });
    } catch {
      return next();
    }
    if (!target) return next();

    try {
      const upstream = await fetchImpl(target.url, {
        method: 'GET',
        headers: {
          // Bearer, not the loopback cookie: the team server knows nothing about
          // this machine's cookie and would reject it.
          authorization: `Bearer ${target.key}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await upstream.text();
      res.status(upstream.status);
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
      // Marks a proxied response so the origin of the data is visible in
      // devtools — otherwise a team read is indistinguishable from a local one.
      res.setHeader('x-memsmith-proxied', 'team');
      res.send(body);
    } catch (error) {
      // The team server is unreachable or slow. Falling through renders the
      // LOCAL view rather than an error page — degraded but honest, and the
      // x-memsmith-proxied header is absent so the difference is visible.
      logger.warn('HTTP', 'team read proxy failed; serving locally', { path: req.path },
        error instanceof Error ? error : new Error(String(error)));
      next();
    }
  };
}
