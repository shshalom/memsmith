// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/join/register — the REMOTE half of join-over-HTTPS.
//
// Today a joining teammate opens a direct Postgres connection to the team
// database, which means possessing a URL with the database password in it. Join
// needs INSERT on projects/teams, so that URL cannot be narrowed to read-only:
// onboarding one person hands them write access to every table. This route
// moves those writes server-side so the teammate needs only the team key.
//
// It performs the same four checks runJoin does (join-service.ts:105-126).
//
// WHY THE KEY IS A BODY PARAMETER AND NOT `Authorization: Bearer`
// Because the four rejection reasons must stay distinct. postgres-auth
// resolveApiKey returns null for missing, revoked, expired AND
// insufficient-scope alike (postgres-auth.ts:360-370) → one flat 401 at line
// 222. A teammate whose key was revoked would see only "unauthorized" and have
// to go ask the owner why. So the key is inspected as DATA.
//
// That makes this route reachable without prior authentication, which is why the
// rate limiter is not optional in production — see requireJoinRateLimit.
//
// WHY `projectId` MAY COME FROM THE BODY HERE
// This is the only place in the codebase where that is true. The row is CREATED
// under the team named by the KEY, never read from another team. The composite
// FK projects(id, team_id) makes the team half non-negotiable and the team half
// comes from the credential, so a caller can only ever create a project inside
// its own team — and naming a fresh id reveals nothing, because nothing exists
// at it yet. Contrast resolve-requested-project.ts, which exists to stop a
// request WIDENING A READ to an existing project.

import type { RequestHandler } from 'express';
import { logger } from '../../../utils/logger.js';

/** The api_keys columns this route needs. */
export interface JoinKeyRow {
  teamId: string | null;
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}

export interface JoinRegisterDeps {
  /** Middleware to run before the handler. Production MUST pass a limiter. */
  rateLimit?: RequestHandler[];
  /** Look up an api_keys row by its hash. Returns null when unknown. */
  lookupKey: (keyHash: string) => Promise<JoinKeyRow | null>;
  /** Idempotently register the project under the team. */
  upsertProject: (teamId: string, projectId: string, name?: string) => Promise<void>;
  /** Hash a raw key the same way api_keys stores it. */
  hashKey: (raw: string) => string;
}

/** 422, not 401/403: a wrong key is user-correctable input shown inline. */
function reject(res: any, error: string): void {
  res.status(422).json({ status: 'failed', error });
}

export function registerJoinRegisterRoute(app: any, deps: JoinRegisterDeps): void {
  app.post('/v1/join/register', ...(deps.rateLimit ?? []), async (req: any, res: any) => {
    const teamKey = typeof req.body?.teamKey === 'string' ? req.body.teamKey.trim() : '';
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const projectName = typeof req.body?.projectName === 'string' ? req.body.projectName : undefined;
    if (!teamKey) return reject(res, 'team key is required');
    if (!projectId) return reject(res, 'projectId is required');

    let row: JoinKeyRow | null;
    try {
      row = await deps.lookupKey(deps.hashKey(teamKey));
    } catch (err) {
      // A lookup failure is OUR fault, not a bad key. Reporting it as an invalid
      // key would send the user chasing the wrong fix.
      logger.warn('HTTP', 'join register key lookup failed', {},
        err instanceof Error ? err : new Error(String(err)));
      res.status(500).json({ status: 'failed', error: 'could not verify the key' });
      return;
    }

    if (!row) return reject(res, 'that key is not valid for this workspace');
    if (row.revokedAt) return reject(res, 'that key has been revoked');
    const expires = row.expiresAt ? new Date(String(row.expiresAt)).getTime() : null;
    if (expires !== null && Number.isFinite(expires) && expires <= Date.now()) {
      return reject(res, 'that key has expired');
    }
    // A key with no team cannot scope anything; joining with it would leave the
    // project authenticated but unroutable.
    if (!row.teamId) return reject(res, 'that key is not scoped to a team');

    try {
      // teamId from the KEY'S ROW. Any teamId in the body is ignored entirely.
      await deps.upsertProject(row.teamId, projectId, projectName);
    } catch (err) {
      // Deliberately does NOT echo err.message: a pg error can embed the
      // connection string, and this route exists precisely to keep that
      // server-side.
      logger.warn('HTTP', 'join register upsert failed', { projectId },
        err instanceof Error ? err : new Error(String(err)));
      res.status(500).json({ status: 'failed', error: 'could not register this project' });
      return;
    }

    // Nothing secret in the response — no database URL, no password.
    res.status(200).json({ status: 'joined', teamId: row.teamId });
  });
}
