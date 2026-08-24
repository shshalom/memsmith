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

/**
 * POST endpoints that only ever READ, so they are safe to forward.
 *
 * Explicit allow-list rather than a method rule: /v1/search is a read that uses
 * POST (its filters do not fit a query string), and gating on GET alone left the
 * Observations tab empty while the metrics tile showed the team's rows. Listing
 * paths means a future POST route is refused by default instead of silently
 * becoming a write channel to someone else's server.
 */
const READ_ONLY_POST_PATHS = new Set<string>(['/v1/search', '/v1/context']);

/**
 * Endpoints that answer about THIS MACHINE and must never be forwarded.
 *
 * /v1/identity is the clearest case: it reports the local marker's runtime and
 * whether this machine holds the key. Proxied, the team server answers about its
 * OWN view — where the project is just a server-side row with no local marker —
 * so a joined project came back `runtime: "local", keyPresent: false` and the
 * dashboard displayed it as local right after a successful join. The data tiles
 * were showing the team's rows at the same time, which is how the contradiction
 * surfaced.
 *
 * /v1/info is the same shape: it describes the local process (ports, schema
 * version, generation health), not the team's.
 */
export const LOCAL_ONLY_PATHS = new Set<string>(['/v1/identity', '/v1/info', '/v1/projects']);

/** Path without the query string, from the ORIGINAL url (mount prefix intact). */
function pathOf(req: Request): string {
  const i = req.originalUrl.indexOf('?');
  return i === -1 ? req.originalUrl : req.originalUrl.slice(0, i);
}

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
    // READS ONLY — but "read" is not the same as "GET". The Observations tab
    // POSTs to /v1/search, so a GET-only rule left that tab empty while the
    // metrics tile (a GET) showed the team's 14 rows: a dashboard reporting
    // data it would not display.
    //
    // So the allowance is by PATH, not by method: an explicit list of endpoints
    // that only ever read. Everything else — every write, every route not named
    // here — is refused, so this cannot become an unaudited write channel just
    // because a future route happens to use POST.
    // Never forward a question about THIS machine. /v1/identity reports the
    // local marker's runtime and whether this machine holds the key — proxied,
    // the team answered about its own view and a joined project came back
    // "local, keyPresent:false" while its data tiles showed the team's rows.
    if (LOCAL_ONLY_PATHS.has(pathOf(req))) return next();

    const isGet = req.method === 'GET';
    const isReadPost = req.method === 'POST' && READ_ONLY_POST_PATHS.has(pathOf(req));
    if (!isGet && !isReadPost) return next();

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
        method: req.method,
        headers: {
          // Bearer, not the loopback cookie: the team server knows nothing about
          // this machine's cookie and would reject it.
          authorization: `Bearer ${target.key}`,
          accept: 'application/json',
          ...(isReadPost ? { 'content-type': 'application/json' } : {}),
        },
        // Forward the search filters. Without the body the team server would run
        // an empty query and the tab would stay blank for a different reason.
        ...(isReadPost ? { body: JSON.stringify(req.body ?? {}) } : {}),
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
