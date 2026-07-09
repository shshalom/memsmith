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

export class ServerViewerRoutes implements RouteHandler {
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

    app.get('/', (_req: Request, res: Response) => {
      if (!viewerHtmlBytes) {
        res.status(503).json({ error: 'ViewerUnavailable', message: 'Viewer UI not found at any expected location' });
        return;
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
