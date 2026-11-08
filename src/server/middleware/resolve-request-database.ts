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
import { resolveMergeChain } from '../../services/projects/merge-chain.js';

export interface ResolveRequestDatabaseOptions {
  // The cold-boot/dogfood project's database lives in the base database, not
  // msp_<id>. This mapping is recorded once at server construction time.
  baseDatabaseName: string;
  baseProjectId: string | null;
  /**
   * Account database. When given, a request for a project archived by
   * `memsmith merge` is routed to the project it was merged into. The target
   * comes from the projects table, never from the request.
   */
  accountPool?: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
  /** True only on the local runtime, where a merge may join projects from different teams. */
  localRuntime?: boolean;
}

/** Remembers values to act on once each; forgets them all when full, so it never grows without bound. */
export class BoundedSeen {
  private readonly values = new Set<string>();
  constructor(private readonly limit: number) {}
  get size(): number { return this.values.size; }
  first(value: string): boolean {
    if (this.values.has(value)) return false;
    if (this.values.size >= this.limit) this.values.clear();
    this.values.add(value);
    return true;
  }
}

const loggedRedirects = new BoundedSeen(1000);



// Returns false after answering the request itself.
async function followMerge(opts: ResolveRequestDatabaseOptions, req: Request, res: Response): Promise<boolean> {
  const projectId = req.authContext?.projectId;
  if (!opts.accountPool || !projectId || !req.authContext) return true;
  let chain;
  try {
    chain = await resolveMergeChain(opts.accountPool, projectId);
  } catch {
    return true;
  }
  if (chain.kind === 'active') return true;
  if (chain.kind === 'broken') {
    logger.warn('HTTP', 'refused a request for a merged project', { projectId, reason: chain.reason });
    res.status(409).json({ error: 'merged_project_unresolvable', message: chain.reason });
    return false;
  }
  // A merge combines two local projects that may sit in different teams.
  // Anywhere but the local runtime, a credential is never moved into another
  // team; a request's address cannot tell the two apart behind a proxy.
  if (chain.teamId !== req.authContext.teamId && !opts.localRuntime) return true;
  if (loggedRedirects.first(projectId)) {
    logger.info('HTTP', 'routing a merged project to the project it was merged into', { projectId, into: chain.projectId });
  }
  const archived = new Set(chain.via);
  req.authContext.projectId = chain.projectId;
  req.authContext.teamId = chain.teamId;
  // Handlers read body/query projectId before authContext, and refuse a
  // mismatch, so the archived id is replaced there too.
  const body = (req as any).body;
  if (body && typeof body === 'object' && archived.has(body.projectId)) body.projectId = chain.projectId;
  const query = (req as any).query;
  if (query && typeof query === 'object' && ['projectId', 'project'].some((k) => archived.has(query[k]))) {
    const rewritten = { ...query };
    for (const key of ['projectId', 'project']) if (archived.has(rewritten[key])) rewritten[key] = chain.projectId;
    // Express 5 re-parses req.query from the URL on every read; an own property sticks.
    Object.defineProperty(req, 'query', { value: rewritten, writable: true, configurable: true, enumerable: true });
  }
  return true;
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
  if (!(await followMerge(opts, req, res))) return;
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
