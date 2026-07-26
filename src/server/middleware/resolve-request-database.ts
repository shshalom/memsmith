// SPDX-License-Identifier: Apache-2.0
//
// SECURITY INVARIANT: this middleware selects the per-request database using
// ONLY `req.authContext.projectId` (and `req.authContext.teamId`). It must
// NEVER read `req.query.projectId`, `req.body.projectId`, headers, or any
// other client-supplied field to choose a database. authContext is populated
// upstream (requirePostgresServerAuth) from a trusted source for every auth
// mode — including the local-dev bypass, which funnels the request-supplied
// project id INTO authContext before this middleware ever runs. Do NOT
// "helpfully" add a query-param/body override here: that would let a caller
// pick another tenant's database and is a cross-tenant data-access
// vulnerability.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PoolRegistry } from '../../storage/postgres/pool-registry.js';
import { projectDatabaseName } from '../runtime/resolve-project-database.js';
import { logger } from '../../utils/logger.js';

export interface ResolveRequestDatabaseOptions {
  // The cold-boot/dogfood project's database lives in the base database, not
  // msp_<id>. This mapping is recorded once at server construction time.
  baseDatabaseName: string;
  baseProjectId: string | null;
}

/**
 * Resolves `req.databasePool` from `req.authContext.projectId` alone (see the
 * invariant above) and calls next(). Responds 400 if there is no projectId
 * (never silently falls back to the base database — that would reintroduce
 * the cross-tenant leak this feature fixes) and 500 if pool provisioning
 * fails.
 */
export function resolveRequestDatabase(
  registry: PoolRegistry,
  opts: ResolveRequestDatabaseOptions,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => handle(registry, opts, req, res, next);
}

async function handle(
  registry: PoolRegistry,
  opts: ResolveRequestDatabaseOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const projectId = req.authContext?.projectId ?? null;
  // teamId is advisory (used only for hinge-row seeding on first provision);
  // only projectId gates routing. Coalesce null → '' to satisfy getPool's ids
  // shape without inventing a second auth requirement here.
  const teamId = req.authContext?.teamId ?? '';

  if (!projectId) {
    res.status(400).json({ error: 'no project identity' });
    return;
  }

  const databaseName =
    projectId === opts.baseProjectId ? opts.baseDatabaseName : projectDatabaseName(projectId);

  try {
    req.databasePool = await registry.getPool(databaseName, { teamId, projectId });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('HTTP', 'resolveRequestDatabase: pool provisioning failed', { databaseName }, err);
    res.status(500).json({ error: 'database unavailable' });
    return;
  }

  next();
}
