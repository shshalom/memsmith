// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresTeamRole } from '../../storage/postgres/teams.js';
import { PostgresTeamsRepository } from '../../storage/postgres/teams.js';
import { LOCAL_OWNER_USER_ID } from '../identity/providers/local-provider.js';

// AuthContext was previously in src/server/middleware/auth.ts (deleted in Tasks
// 12+13 — that file was the SQLite-backed worker auth middleware). AuthContext is
// a shared type used by all middleware and routes, so it lives here now.
export interface AuthContext {
  userId: string | null;
  organizationId: string | null;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
  apiKeyId: string | null;
  mode: 'api-key' | 'local-dev' | 'session';
  role: PostgresTeamRole | null;
}

// Role ordering: viewer < member < admin < owner
const ROLE_ORDER: Record<PostgresTeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/**
 * Returns true iff `role` meets or exceeds `min`.
 * Fail-safe: null (no membership) always returns false.
 */
export function roleSatisfies(role: PostgresTeamRole | null, min: PostgresTeamRole): boolean {
  return role != null && ROLE_ORDER[role] >= ROLE_ORDER[min];
}

/**
 * Route guard: calls next() when the authenticated principal's role satisfies
 * `min`; otherwise responds 403 Forbidden.
 *
 * ORDERING: MUST run after requirePostgresServerAuth (which populates
 * req.authContext). If authContext is absent, role is undefined → roleSatisfies
 * returns false → 403 (fail-closed). The ordering dependency must be enforced
 * by route registration, not relied on implicitly.
 */
export function requireRole(min: PostgresTeamRole): RequestHandler {
  return (req, res, next) => {
    if (roleSatisfies(req.authContext?.role ?? null, min)) return next();
    res.status(403).json({ error: 'Forbidden', message: `requires role ${min}` });
  };
}

/**
 * Route guard for content-mutating routes (observation write/delete).
 * Requires a >= member role, BUT treats a null role (legacy/scope-only key:
 * no user_id, or user not in team_members) as member-equivalent so existing
 * scope-only keys keep working. Only an explicit role strictly below member
 * (viewer) is denied. Fail-safe: absent authContext → 403.
 *
 * ORDERING: MUST run after requirePostgresServerAuth (which populates
 * req.authContext incl. role). Enforced by route-registration order.
 */
export function requireWriteRole(): RequestHandler {
  return (req, res, next) => {
    const ctx = req.authContext;
    if (!ctx) {
      res.status(403).json({ error: 'Forbidden', message: 'requires role member or higher' });
      return;
    }
    const role = ctx.role; // PostgresTeamRole | null
    const allow = role == null || roleSatisfies(role, 'member');
    if (allow) return next();
    res.status(403).json({ error: 'Forbidden', message: 'requires role member or higher' });
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    authContext?: AuthContext;
    // Per-request database pool, set by resolveRequestDatabase (Task 4) after
    // routing on req.authContext.projectId. See
    // src/server/middleware/resolve-request-database.ts for the security
    // invariant governing how this is chosen.
    databasePool?: PostgresPool;
  }
}
import type { PostgresApiKey } from '../../storage/postgres/auth.js';
import {
  hasForwardedClientHeaders,
  hasLoopbackHostHeader,
  isLocalhost,
  parseBearerToken,
} from './request-auth-helpers.js';
import { readLocalKeyCookie } from '../runtime/local-key-cookie.js';
import { logger } from '../../utils/logger.js';
import { resolveIdentityProvider } from '../identity/provider-factory.js';

// Postgres-backed auth middleware for the server-beta runtime.
//
// Mirrors src/server/middleware/auth.ts but reads API keys from the Postgres
// `api_keys` table instead of bun:sqlite. Phase 4 routes use this so the
// runtime depends only on the Postgres pool and Postgres-backed repositories.
//
// teamId / projectId on req.authContext come straight from the Postgres
// api_keys row. Routes use those to scope every read and write.

export interface PostgresRequireAuthOptions {
  requiredScopes?: string[];
  authMode?: string;
  allowLocalDevBypass?: boolean;
  // Local-dev fallback team for unauthenticated loopback requests. This is
  // only used when authMode === 'local-dev' AND allowLocalDevBypass is true
  // AND the request is on loopback. It must NEVER be used to scope a real
  // production request.
  localDevTeamId?: string | null;
  // Local-dev fallback project, parallel to localDevTeamId. Same rule: only
  // applied inside the loopback + local-dev bypass, NEVER a production request.
  localDevProjectId?: string | null;
}

export function requirePostgresServerAuth(
  pool: PostgresPool,
  options: PostgresRequireAuthOptions = {},
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authenticatePostgresRequest(pool, options, req, res, next);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('HTTP', 'postgres auth middleware failed', { path: req.path }, err);
      next(error);
    }
  };
}

async function authenticatePostgresRequest(
  pool: PostgresPool,
  options: PostgresRequireAuthOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authMode = options.authMode ?? process.env.MEMSMITH_AUTH_MODE ?? 'api-key';
  const authorization = req.header('authorization') ?? '';
  const xApiKey = req.header('x-api-key')?.trim() ?? '';
  // Bearer is canonical; raw X-Api-Key is a fallback so clients using
  // @better-auth/api-key defaults (e.g. the worker bundle shipped from the
  // Windows-canary line) authenticate without a per-client custom config.
  // Third source: the loopback cookie GET / issues to the local dashboard,
  // carrying the base key this machine already minted. EventSource cannot send
  // headers, so a cookie is the only mechanism that serves both fetch and SSE.
  // Accepted ONLY from a loopback origin — a cookie arriving from anywhere else
  // is ignored outright, so this cannot widen remote access. The key itself is
  // still verified by the normal api-key path below; this is a transport for an
  // existing credential, not a bypass.
  const cookieKey = (isLocalhost(req) && hasLoopbackHostHeader(req) && !hasForwardedClientHeaders(req))
    ? readLocalKeyCookie(req.header('cookie'))
    : null;
  const rawKey = parseBearerToken(authorization) || xApiKey || cookieKey || null;

  const allowLocalDevBypass = options.allowLocalDevBypass
    ?? process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS === '1';
  if (
    !rawKey
    && authMode === 'local-dev'
    && allowLocalDevBypass
    && isLocalhost(req)
    && hasLoopbackHostHeader(req)
    && !hasForwardedClientHeaders(req)
  ) {
    // local-dev bypass ONLY: take the project from the request so a SECOND local
    // project on the shared server routes to its own database. Safe because this
    // branch is loopback + local-dev (single-user machine), never multi-tenant.
    // api-key mode below is unaffected: its projectId comes from the api_keys row.
    //
    // This makes authContext the ONE routing source for every mode (Task 4's
    // db-routing middleware reads ONLY authContext.projectId, never raw request
    // fields) — putting the request-read here, inside the trusted loopback
    // branch, is what keeps that invariant clean everywhere else.
    const requestProjectId =
      (typeof (req as any).body?.projectId === 'string' && (req as any).body.projectId.trim())
      || (typeof (req as any).query?.projectId === 'string' && (req as any).query.projectId.trim())
      || '';
    const ctx: AuthContext = {
      userId: LOCAL_OWNER_USER_ID,
      organizationId: null,
      teamId: options.localDevTeamId ?? null,
      projectId: requestProjectId || options.localDevProjectId || null,
      scopes: ['local-dev', 'memories:read', 'memories:write', 'settings:admin'],
      apiKeyId: null,
      mode: 'local-dev',
      role: 'owner',
    };
    req.authContext = ctx;
    next();
    return;
  }

  if (!rawKey) {
    // No API key. In 'api-key' mode, a missing key is always a hard 401 —
    // the identity provider is never consulted so the security boundary is
    // preserved. In other modes, try the configured identity provider for
    // session-based auth (e.g. better-auth cookie sessions).
    //
    // For 'local-dev' mode without the bypass (e.g. allowLocalDevBypass=false
    // or loopback checks not satisfied), a keyless request still reaches this
    // branch. The local identity provider resolves it as an implicit local owner
    // (single-user local mode). That is intentional: local mode is not
    // multi-tenant, so any request from the local UI gets owner identity.
    //
    // FAIL-SAFE: provider.authenticate throwing or returning null → 401, never crash.
    const provider = authMode !== 'api-key' ? resolveIdentityProvider(process.env) : null;
    let authnResult: import('../identity/identity-provider.js').AuthnResult | null = null;
    if (provider) {
      try {
        authnResult = await provider.authenticate(req);
      } catch {
        // Provider threw — treat as unauthenticated (fail-safe deny).
        authnResult = null;
      }
    }
    if (!authnResult) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)',
      });
      return;
    }
    // Provider resolved a user — role resolution requires a teamId which is not
    // available from session auth alone. Role stays null (fail-safe: deny
    // role-gated routes; a future extension can derive teamId from authnResult
    // and call getMemberRole here).
    //
    // Scope gate: symmetric with the api-key path. The session is granted a
    // conservative fixed set of scopes. Check them against requiredScopes using
    // the same hasRequiredScopes helper the api-key path uses. On mismatch →
    // deny (403, consistent with api-key insufficient-scope response). If
    // requiredScopes is empty/undefined → allow (matches api-key semantics).
    const sessionScopes = ['memories:read', 'memories:write'];
    const requiredScopes = options.requiredScopes ?? [];
    if (!hasRequiredScopes(sessionScopes, requiredScopes)) {
      res.status(403).json({ error: 'Forbidden', message: 'Invalid API key or insufficient scope' });
      return;
    }
    const sessionUserId = authnResult.userId;
    const sessionRole: PostgresTeamRole | null = null;
    const sessionCtx: AuthContext = {
      userId: sessionUserId,
      organizationId: null,
      teamId: null,
      projectId: null,
      scopes: sessionScopes,
      apiKeyId: null,
      mode: 'session',
      role: sessionRole,
    };
    req.authContext = sessionCtx;
    next();
    return;
  }

  const verified = await verifyPostgresApiKey(pool, rawKey, options.requiredScopes ?? []);
  if (!verified) {
    res.status(403).json({ error: 'Forbidden', message: 'Invalid API key or insufficient scope' });
    return;
  }

  // Resolve role from team_members. Fail-safe: any error → role=null (deny).
  // Legacy null-owner keys (userId=null) get role=null but scope-based behavior is unchanged.
  let role: PostgresTeamRole | null = null;
  const userId = verified.userId;
  const teamId = verified.teamId;
  if (userId != null && teamId != null) {
    try {
      const teamsRepo = new PostgresTeamsRepository(pool);
      role = await teamsRepo.getMemberRole(teamId, userId);
    } catch {
      // Fail-safe: DB error → deny (role stays null). Never throw out of middleware.
      role = null;
    }
  }

  const ctx: AuthContext = {
    userId,
    organizationId: null,
    teamId: verified.teamId,
    projectId: verified.projectId,
    scopes: verified.scopes,
    apiKeyId: verified.apiKeyId,
    mode: 'api-key',
    role,
  };
  req.authContext = ctx;
  next();
}

interface VerifiedPostgresApiKey {
  apiKeyId: string;
  teamId: string | null;
  projectId: string | null;
  userId: string | null;
  scopes: string[];
}

export async function verifyPostgresApiKey(
  pool: PostgresPool,
  rawKey: string,
  requiredScopes: string[],
): Promise<VerifiedPostgresApiKey | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const result = await pool.query(
    `
      SELECT id, team_id, project_id, user_id, scopes, revoked_at, expires_at
      FROM api_keys
      WHERE key_hash = $1
    `,
    [keyHash],
  );
  const row = result.rows[0] as Pick<
    PostgresApiKey,
    'id' | 'teamId' | 'projectId' | 'userId'
  > & {
    id: string;
    team_id: string | null;
    project_id: string | null;
    user_id: string | null;
    scopes: unknown;
    revoked_at: Date | null;
    expires_at: Date | null;
  } | undefined;
  if (!row) {
    return null;
  }
  if (row.revoked_at) {
    return null;
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return null;
  }
  const scopes = normalizeScopes(row.scopes);
  if (!hasRequiredScopes(scopes, requiredScopes)) {
    return null;
  }
  return {
    apiKeyId: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    userId: row.user_id ?? null,
    scopes,
  };
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}
