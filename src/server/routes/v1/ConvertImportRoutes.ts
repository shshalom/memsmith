// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/convert/import — receive one batch of relocated rows.
// GET  /v1/convert/verify — per-table row counts for a project, computed server-side.
//
// WHY VERIFY IS A SERVER ROUTE. buildScopedCountQuery emits different SQL for local and
// remote, and the remote variant needs team_id — but `observation_sources` has NEITHER
// project_id NOR team_id, so its count is a correlated subquery through the parent table
// (convert-scope.ts:29-31). A client cannot express that. Only the server can answer
// "how many rows of this table belong to this project".
//
// AUTH. Owner-gated, like every other convert route (ServerV1PostgresRoutes.ts:1704).
// NOT requireWriteRole(), which treats role == null as member-equivalent
// (postgres-auth.ts:69): this route writes raw rows into seven tables, so a roleless key
// must never reach it. And a TEAM-SCOPED key (project_id IS NULL) is refused explicitly,
// because ensureProjectAllowed passes such a key for ANY project in its team — it has not
// identified which project is being imported, and guessing is the whole convert-scope
// failure history.

import type { Application, RequestHandler, Request, Response } from 'express';
import { COPY_TABLES } from '../../convert/copy-engine.js';
import { applyImportBatch, resolveImportProject, type ApplyDeps } from '../../convert/import-apply.js';
import { buildScopedCountQuery } from './convert-scope.js';
import { randomUUID } from 'crypto';
import { LOCAL_OWNER_USER_ID } from '../../identity/providers/local-provider.js';

export interface ConvertImportDeps {
  /** Must be `[...writeAuth, requireRole('owner')]` — see the auth note above. */
  authMiddleware: RequestHandler[];
  /**
   * FALLBACK pool only. Per request, `req.databasePool` wins — see `poolFor`.
   *
   * MemSmith routes reads and writes to a PER-PROJECT database (`msp_<id>`), and
   * `resolveRequestDatabase` (inside writeAuth) resolves it onto `req.databasePool`.
   * Using this base pool unconditionally wrote imported rows into the BASE database
   * while every read looked in the project database — the rows existed, a direct COUNT
   * found them, and search returned nothing. 27 other routes already use the
   * `req.databasePool ?? pool` form; this one must too.
   */
  pool: ApplyDeps;
}

/**
 * The database this request must act on: the per-project pool when routing resolved one,
 * otherwise the base pool (single-database deployments, where they are the same thing).
 */
function poolFor(req: Request, fallback: ApplyDeps): ApplyDeps {
  return ((req as unknown as { databasePool?: ApplyDeps }).databasePool) ?? fallback;
}

/**
 * A RESOLVED scope: both ids are non-null by construction, so callers never have to
 * re-check. `readScope` returns null instead of a partially-filled object, which is what
 * keeps the refusal path and the happy path from blurring together.
 */
interface AuthScope {
  projectId: string;
  teamId: string;
}

/**
 * Read the authenticated scope. Returns null when either id is missing, which is the
 * refusal case: a credential without a project scope has not said which project it is
 * acting on.
 */
function readScope(req: Request): AuthScope | null {
  const ctx = (req as unknown as { authContext?: { projectId?: string | null; teamId?: string | null } }).authContext;
  const projectId = ctx?.projectId ?? null;
  const teamId = ctx?.teamId ?? null;
  if (!projectId || !teamId) return null;
  return { projectId, teamId };
}

export function registerConvertImportRoutes(app: Application, deps: ConvertImportDeps): void {
  app.post('/v1/convert/import', ...deps.authMiddleware, async (req: Request, res: Response) => {
    const scope = readScope(req);
    if (!scope) {
      res.status(400).json({
        error: 'no project scope on this credential — cannot determine which project to import into',
      });
      return;
    }

    const body = (req.body ?? {}) as {
      table?: unknown; rows?: unknown; batchToken?: unknown; projectId?: unknown;
    };
    const table = typeof body.table === 'string' ? body.table : '';
    // The table name is interpolated into SQL, so the allowlist is the boundary. It also
    // refuses the account tables (teams, team_members, api_keys, server_settings), which
    // convert deliberately never copies.
    if (!COPY_TABLES.includes(table)) {
      res.status(400).json({ error: `table not importable: ${table || '(none)'}` });
      return;
    }
    const batchToken = typeof body.batchToken === 'string' ? body.batchToken.trim() : '';
    if (!batchToken) {
      // Without a token a retry cannot be recognised, and per-batch idempotency is the
      // only retry protection most rows have.
      res.status(400).json({ error: 'batchToken is required' });
      return;
    }
    if (!Array.isArray(body.rows)) {
      res.status(400).json({ error: 'rows must be an array' });
      return;
    }

    // A migration relocates rows, so the SOURCE project is part of the data. Validated
    // against the credential's entitlement rather than trusted or overwritten — see
    // resolveImportProject. Overwriting silently re-homed an entire convert.
    const db = poolFor(req, deps.pool);
    const resolved = await resolveImportProject(db, {
      requested: typeof body.projectId === 'string' ? body.projectId : undefined,
      keyProjectId: scope.projectId,
      keyTeamId: scope.teamId,
    });
    if (!resolved.ok) {
      res.status(403).json({ error: 'Forbidden', message: resolved.reason });
      return;
    }

    try {
      const result = await applyImportBatch(db, {
        projectId: resolved.projectId,
        teamId: scope.teamId,
        table,
        rows: body.rows as Array<Record<string, unknown>>,
        batchToken,
      });
      res.status(200).json({ ...result, projectId: resolved.projectId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'import failed' });
    }
  });

  // POST /v1/convert/register-key — teach this server about the CONVERTING project's
  // own key.
  //
  // A project's key is minted at creation and never changes; a convert changes where the
  // project points, not who it is. The direct-Postgres path preserves that by inserting
  // the project's existing key hash into api_keys over its pool (ensureBaseKey). The
  // HTTPS path has no pool, so it asks the server to do the same insert.
  //
  // Only the HASH is accepted — never a plaintext key. The remote stores hashes, so a
  // plaintext would be a live credential in a request body and in logs for no benefit.
  app.post('/v1/convert/register-key', ...deps.authMiddleware, async (req: Request, res: Response) => {
    const scope = readScope(req);
    if (!scope) {
      res.status(400).json({ error: 'no project scope on this credential' });
      return;
    }
    const body = (req.body ?? {}) as { projectId?: unknown; keyHash?: unknown };
    const keyHash = typeof body.keyHash === 'string' ? body.keyHash.trim().toLowerCase() : '';
    // A SHA-256 hex digest and nothing else. This value is interpolated into an
    // api_keys row that grants access, so its shape is validated rather than trusted.
    if (!/^[0-9a-f]{64}$/.test(keyHash)) {
      res.status(400).json({ error: 'keyHash must be a sha256 hex digest' });
      return;
    }

    // api_keys is an ACCOUNT table: it lives in the BASE database, not the per-project
    // one (schema.ts:161 — "api_keys is an ACCOUNT_SCHEMA_SQL table"). Using the
    // per-project pool here failed with 'relation "api_keys" does not exist'. The
    // entitlement probe reads `projects`, which the base database also holds, so both
    // use the base pool on this route.
    const db = deps.pool;
    // Same entitlement rule as import: the project must be one this credential can
    // reach, or registering a key would be a grant-anywhere lever.
    const resolved = await resolveImportProject(db, {
      requested: typeof body.projectId === 'string' ? body.projectId : undefined,
      keyProjectId: scope.projectId,
      keyTeamId: scope.teamId,
    });
    if (!resolved.ok) {
      res.status(403).json({ error: 'Forbidden', message: resolved.reason });
      return;
    }

    try {
      const existing = await db.query(
        'SELECT 1 FROM api_keys WHERE key_hash = $1 AND team_id = $2 LIMIT 1',
        [keyHash, scope.teamId],
      );
      if (existing.rows.length > 0) {
        res.status(200).json({ status: 'already_registered', projectId: resolved.projectId });
        return;
      }
      // user_id must be set: authContext.role joins api_keys.user_id to team_members, so
      // a NULL leaves the role unresolvable and owner-gated routes unsatisfiable.
      await db.query(
        `INSERT INTO api_keys (id, key_hash, team_id, project_id, user_id, actor_id, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          randomUUID(), keyHash, scope.teamId, resolved.projectId,
          LOCAL_OWNER_USER_ID, 'system:convert',
          JSON.stringify(['memories:read', 'memories:write']),
        ],
      );
      res.status(200).json({ status: 'registered', projectId: resolved.projectId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'register-key failed' });
    }
  });

  app.get('/v1/convert/verify', ...deps.authMiddleware, async (req: Request, res: Response) => {
    const scope = readScope(req);
    if (!scope) {
      res.status(400).json({ error: 'no project scope on this credential' });
      return;
    }

    // Count the project the caller ASKS about, not whatever the credential happens to
    // scope to. Counting by the credential is what let a re-homed import pass
    // verification: the copy wrote 3 rows under the key's project, verify counted the
    // key's project, saw 3, and matched the source count of a DIFFERENT project.
    const db = poolFor(req, deps.pool);
    const asked = typeof req.query?.projectId === 'string' ? req.query.projectId : undefined;
    const resolved = await resolveImportProject(db, {
      requested: asked,
      keyProjectId: scope.projectId,
      keyTeamId: scope.teamId,
    });
    if (!resolved.ok) {
      res.status(403).json({ error: 'Forbidden', message: resolved.reason });
      return;
    }
    const countScope = { projectId: resolved.projectId, teamId: scope.teamId };

    try {
      const counts: Record<string, number> = {};
      for (const table of COPY_TABLES) {
        // 'remote' because this server IS the destination for an import.
        const q = buildScopedCountQuery(table, 'remote');
        const r = await db.query(q.text, q.params(countScope));
        counts[table] = Number((r.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
      }
      res.status(200).json({ counts, projectId: resolved.projectId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'verify failed' });
    }
  });
}
