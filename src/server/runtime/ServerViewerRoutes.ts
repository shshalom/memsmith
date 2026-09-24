// SPDX-License-Identifier: Apache-2.0
//
// #2552 — Viewer UI on the server runtime.
//
// The Viewer UI (plugin/ui/viewer.html) is served by the in-plugin worker via
// ViewerRoutes, but the server-beta runtime never mounted any static handler,
// so the viewer was unreachable. This handler mirrors the worker's static
// serving: it caches viewer.html at boot and serves it at `/` plus any static
// assets under the package `ui` directory. The viewer's API calls resolve
// against the same Express app (the /v1/* routes and the legacy
// /api/sessions/* compat adapters are already registered on it).

import express, { type Application, type Request, type Response } from 'express';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import type { RouteHandler } from '../../services/server/Server.js';
import { getPackageRoot } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  buildLocalKeyCookie,
  buildClearedLocalKeyCookie,
  decideViewerCookie,
  readLocalKeyCookie,
} from './local-key-cookie.js';
import {
  isLocalhost,
  hasLoopbackHostHeader,
  hasForwardedClientHeaders,
} from '../middleware/request-auth-helpers.js';

const VIEWER_HTML_CANDIDATE_PATHS: readonly string[] = (() => {
  const packageRoot = getPackageRoot();
  // In production the built server-service.cjs lives under plugin/scripts/,
  // so getPackageRoot() returns plugin/ and the first candidate resolves.
  // In development/test, paths.ts is imported as source from src/shared/,
  // so getPackageRoot() returns src/ — we need to climb one more level.
  const parentRoot = path.join(packageRoot, '..');
  return [
    path.join(packageRoot, 'ui', 'viewer.html'),
    path.join(packageRoot, 'plugin', 'ui', 'viewer.html'),
    path.join(parentRoot, 'ui', 'viewer.html'),
    path.join(parentRoot, 'plugin', 'ui', 'viewer.html'),
  ];
})();

const resolvedViewerHtmlPath: string | null =
  VIEWER_HTML_CANDIDATE_PATHS.find(candidate => existsSync(candidate)) ?? null;

const viewerHtmlBytes: Buffer | null = resolvedViewerHtmlPath
  ? readFileSync(resolvedViewerHtmlPath)
  : null;

if (resolvedViewerHtmlPath) {
  logger.info('SYSTEM', 'Cached viewer.html at boot (server runtime)', {
    path: resolvedViewerHtmlPath,
    bytes: viewerHtmlBytes!.byteLength,
  });
} else {
  logger.warn('SYSTEM', 'viewer.html not found for server runtime', {
    candidates: VIEWER_HTML_CANDIDATE_PATHS,
  });
}

export interface ServerViewerRoutesOptions {
  // Resolves the local API key to hand a loopback browser, for the project
  // named by ?project= (falling back to the server's own). Omitted in
  // team/server mode, where the operator authenticates normally and no
  // machine-local credential should be issued.
  resolveLocalKey?: (requestedProjectId?: string) => string | null | Promise<string | null>;
}

export class ServerViewerRoutes implements RouteHandler {
  constructor(private readonly options: ServerViewerRoutesOptions = {}) {}

  setupRoutes(app: Application): void {
    const packageRoot = getPackageRoot();
    const parentRoot = path.join(packageRoot, '..');
    // Serve static assets from candidate ui directories, covering both the
    // production layout (plugin/ root → ui/ dir) and the dev/test layout
    // (project root → plugin/ui/ dir).
    app.use(express.static(path.join(packageRoot, 'ui')));
    app.use(express.static(path.join(packageRoot, 'plugin', 'ui')));
    app.use(express.static(path.join(parentRoot, 'ui')));
    app.use(express.static(path.join(parentRoot, 'plugin', 'ui')));

    app.get('/', async (req: Request, res: Response) => {
      if (!viewerHtmlBytes) {
        res.status(503).json({ error: 'ViewerUnavailable', message: 'Viewer UI not found at any expected location' });
        return;
      }
      // Hand the loopback browser the base key this machine already minted, so
      // the dashboard can authenticate against its own data. Without this the
      // viewer sends no credential at all and every /dashboard and /v1 read
      // 401s. Gated on loopback by BOTH the socket peer and the Host header:
      // the socket check alone would still issue the cookie to a request
      // proxied from elsewhere, and a forwarded-client header means the
      // request did not originate on this machine.
      if (isLocalhost(req) && hasLoopbackHostHeader(req) && !hasForwardedClientHeaders(req)) {
        // Never let a credential read break serving the page. Losing the cookie
        // degrades the dashboard to unauthenticated; throwing here would 500 the
        // whole viewer. The guarantee lives at the route, not only in the
        // caller's resolver, so every caller inherits it.
        try {
          // ?project=<projectId> selects WHICH project's credential to hand
          // over, so the dashboard — and the Go Team wizard, which converts
          // whatever the request authenticates as — acts on the project the
          // user is actually looking at rather than the server's own.
          const requested = typeof req.query?.project === 'string' ? req.query.project : undefined;
          // A BARE request must NOT overwrite an existing scoped cookie.
          //
          // Without ?project=, resolveLocalKey falls back to the SERVER's own
          // project. Every plain `/` load — a refresh, a client-side route
          // change, any navigation that drops the query string — therefore
          // silently re-scoped the whole dashboard back to the server's project.
          //
          // Measured: visit /?project=<run2> and /v1/identity reports run2/team;
          // one bare `/` load later it reports the dogfood/local. The sidebar
          // still said "ms-p3-run2 · Team" while the Runtime tile showed the
          // DOGFOOD's runtime — two panels describing different projects.
          //
          // Worse than a display bug: the Go Team wizard converts whatever the
          // request authenticates as, so a bare reload before pressing GO TEAM
          // would have aimed it at the server's project instead of the one on
          // screen. That is the convert-scope leak again, reachable from the UI.
          //
          // An explicit ?project= still wins — that is a deliberate switch.
          // The decision now lives in decideViewerCookie, because the branch
          // here was missing a case: an explicit ?project= naming a project this
          // machine holds no key for. resolveLocalKey correctly returned null,
          // this code did nothing, and the browser kept its PREVIOUS cookie — so
          // every API call authenticated as the old project. Measured live: with
          // a dogfood cookie present, /v1/identity?project=<tracked> answered
          // with the dogfood's identity and the requested project appeared
          // nowhere. The tracked-view grant built for exactly this case is never
          // reached, because a valid key was presented and key auth wins.
          const existing = readLocalKeyCookie(req.headers?.cookie);
          const decision = decideViewerCookie({
            requested,
            resolvedKey: (await this.options.resolveLocalKey?.(requested)) ?? null,
            hasExistingCookie: Boolean(existing),
          });
          if (decision.action === 'set' && decision.key) {
            res.setHeader('Set-Cookie', buildLocalKeyCookie(decision.key));
          } else if (decision.action === 'clear') {
            res.setHeader('Set-Cookie', buildClearedLocalKeyCookie());
          }
        } catch (error) {
          logger.warn('SYSTEM', 'could not resolve local key for viewer cookie', {},
            error instanceof Error ? error : new Error(String(error)));
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(viewerHtmlBytes);
    });
  }

  // Exposed for tests: did the build ship a viewer.html the server can serve?
  static hasViewerHtml(): boolean {
    return viewerHtmlBytes !== null;
  }
}
