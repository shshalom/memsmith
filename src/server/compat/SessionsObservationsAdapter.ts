// SPDX-License-Identifier: Apache-2.0

// Legacy compatibility — new clients should use POST /v1/events directly.
//
// Legacy worker payloads to `/api/sessions/observations` are translated into
// the Server beta event/job model and delegated to IngestEventsService. The
// adapter never touches worker code, never queues observations directly, and
// never uses `src/services/worker/*` types.
//
// Translation rules:
//   - `contentSessionId` (Claude Code session UUID) becomes the
//     `external_session_id` of a Server beta `server_sessions` row, scoped to
//     the API key's team and project. The session is create-or-found.
//   - The tool-use shape (tool_name, tool_input, tool_response, tool_use_id)
//     is mapped to an `agent_event` with sourceAdapter='claude-code-compat',
//     eventType='tool_use', payload preserves the legacy fields verbatim.
//   - The API key MUST be project-scoped. Cross-project compat calls return
//     400; we never let compat traffic bypass project scope.

import type { Application, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { RouteHandler } from '../../services/server/Server.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresServerSessionsRepository } from '../../storage/postgres/server-sessions.js';
import { logger } from '../../utils/logger.js';
import { requirePostgresServerAuth } from '../middleware/postgres-auth.js';
import { resolveRequestDatabase } from '../middleware/resolve-request-database.js';
import type { PoolRegistry } from '../../storage/postgres/pool-registry.js';
import { IngestEventsService } from '../services/IngestEventsService.js';
import type { CreatePostgresAgentEventInput } from '../../storage/postgres/agent-events.js';
import { DEFAULT_PLATFORM_SOURCE, normalizePlatformSource } from '../../shared/platform-source.js';

const COMPAT_SOURCE_ADAPTER = 'claude-code-compat';
const COMPAT_EVENT_TYPE = 'tool_use';

const observationsSchema = z.object({
  contentSessionId: z.string().min(1),
  tool_name: z.string().min(1),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  cwd: z.string().optional(),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  platformSource: z.string().optional(),
  tool_use_id: z.string().optional(),
  toolUseId: z.string().optional(),
}).passthrough();

export interface SessionsObservationsAdapterOptions {
  pool: PostgresPool;
  ingestEvents: IngestEventsService;
  authMode?: string;
  allowLocalDevBypass?: boolean;
  // Local-dev fallback team/project — same values the /v1 + /dashboard reads
  // use. Under the loopback local-dev bypass the auth middleware reads these
  // (NOT env) to populate authContext.teamId/projectId; without them the
  // bypassed request has a null team and GET /api/observations 403s.
  localDevTeamId?: string | null;
  localDevProjectId?: string | null;
  // Critical 2 fix — per-request database routing (same as Task 5's V1
  // routes). Optional: when absent, resolveRequestDatabase is never mounted
  // and every DATA-site fallback (`req.databasePool ?? this.options.pool`)
  // resolves to the base pool exactly as before this fix.
  poolRegistry?: PoolRegistry;
  baseDatabaseName?: string;
  baseProjectId?: string | null;
}

export class SessionsObservationsAdapter implements RouteHandler {
  constructor(private readonly options: SessionsObservationsAdapterOptions) {}

  setupRoutes(app: Application): void {
    const writeAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId ?? null,
      localDevProjectId: this.options.localDevProjectId ?? null,
      requiredScopes: ['memories:write'],
    });
    const readAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId ?? null,
      localDevProjectId: this.options.localDevProjectId ?? null,
      requiredScopes: ['memories:read'],
    });
    // Critical 2 fix — mount the same dbRouting middleware Task 5 mounted on
    // the V1 routes, AFTER auth (req.authContext must be populated) and
    // BEFORE any data handler. Only mounted when a registry was actually
    // constructed; otherwise every DATA-site fallback below resolves to the
    // base pool exactly as before this fix.
    const dbRouting: RequestHandler[] = this.options.poolRegistry
      ? [resolveRequestDatabase(this.options.poolRegistry, {
          baseDatabaseName: this.options.baseDatabaseName ?? 'postgres',
          baseProjectId: this.options.baseProjectId ?? null,
        })]
      : [];

    // GET /api/observations — paginated observation list for the viewer's
    // "Observations" tab. The viewer's usePagination hook calls this with
    // ?offset&limit and expects `{ items, hasMore }`, where each item is the
    // viewer `Observation` shape (id/type/text/lifecycle/created_at/...).
    // Scoped to the caller's team/project (server runtime is Postgres-backed,
    // so this reads the same observations table the dashboard board reads).
    app.get('/api/observations', [readAuth, ...dbRouting], this.asyncHandler(async (req, res) => {
      const teamId = req.authContext?.teamId ?? null;
      if (!teamId) {
        res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
        return;
      }
      const projectId = req.authContext?.projectId ?? null;
      const dataPool = req.databasePool ?? this.options.pool;

      const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
      const rawOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

      // Scope: team-only when the key isn't project-bound; team+project otherwise.
      const where = projectId ? 'team_id=$1 AND project_id=$2' : 'team_id=$1';
      const scopeArgs: unknown[] = projectId ? [teamId, projectId] : [teamId];
      // Fetch limit+1 to compute hasMore without a separate COUNT.
      const sql =
        `SELECT id, project_id, obs_type, lifecycle_state, content, created_at
         FROM observations
         WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${scopeArgs.length + 1} OFFSET $${scopeArgs.length + 2}`;
      const result = await dataPool.query(
        sql,
        [...scopeArgs, limit + 1, offset],
      );

      const rows = result.rows as Array<{
        id: string;
        project_id: string;
        obs_type: string | null;
        lifecycle_state: string | null;
        content: string | null;
        created_at: Date | string;
      }>;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map((row) => {
        const createdIso = row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
        return {
          id: row.id,
          memory_session_id: '',
          project: row.project_id,
          merged_into_project: null,
          platform_source: '',
          type: row.obs_type ?? 'change',
          title: null,
          subtitle: null,
          narrative: null,
          text: row.content ?? '',
          facts: null,
          concepts: null,
          files_read: null,
          files_modified: null,
          prompt_number: null,
          created_at: createdIso,
          created_at_epoch: Date.parse(createdIso),
          lifecycle: row.lifecycle_state ?? null,
          supersededBy: null,
        };
      });

      res.status(200).json({ items, hasMore });
    }));

    app.post('/api/sessions/observations', [writeAuth, ...dbRouting], this.asyncHandler(async (req, res) => {
      const parsed = observationsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
        return;
      }
      const teamId = req.authContext?.teamId ?? null;
      const projectId = req.authContext?.projectId ?? null;
      if (!teamId) {
        res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
        return;
      }
      if (!projectId) {
        // Compat mode requires a project-scoped key — the legacy payload does
        // not carry a Server beta projectId, so without scope we cannot place
        // the row in a tenant-scoped table.
        res.status(400).json({
          error: 'BadRequest',
          message: 'Legacy /api/sessions/observations requires a project-scoped API key',
        });
        return;
      }

      try {
        await this.ingestCompatObservation(req, res, parsed.data, teamId, projectId);
      } catch (error) {
        logger.error('SYSTEM', 'compat observations adapter failed', {
          error: error instanceof Error ? error.message : String(error),
          contentSessionId: parsed.data.contentSessionId,
        });
        res.status(500).json({ stored: false, reason: 'internal_error' });
      }
    }));
  }

  // Body of the legacy observations route — translates the legacy payload
  // into a Server beta agent_event and delegates to IngestEventsService.
  private async ingestCompatObservation(
    req: Request,
    res: Response,
    data: z.infer<typeof observationsSchema>,
    teamId: string,
    projectId: string,
  ): Promise<void> {
    const dataPool = req.databasePool ?? this.options.pool;
    const platformSource = normalizePlatformSource(
      typeof data.platformSource === 'string'
        ? data.platformSource
        : DEFAULT_PLATFORM_SOURCE,
    );
    const session = await resolveServerSession({
      pool: dataPool,
      teamId,
      projectId,
      contentSessionId: data.contentSessionId,
      platformSource,
      agentId: typeof data.agentId === 'string' ? data.agentId : null,
      agentType: typeof data.agentType === 'string' ? data.agentType : null,
    });

    const toolUseId = typeof data.tool_use_id === 'string'
      ? data.tool_use_id
      : (typeof data.toolUseId === 'string' ? data.toolUseId : null);

    const input: CreatePostgresAgentEventInput = {
      projectId,
      teamId,
      serverSessionId: session.id,
      sourceAdapter: COMPAT_SOURCE_ADAPTER,
      sourceEventId: toolUseId,
      eventType: COMPAT_EVENT_TYPE,
      // #2560 — persist platform_source on the event row (not just inside
      // payload) so plan-09 scoping/queries can filter by platform.
      platformSource,
      payload: {
        contentSessionId: data.contentSessionId,
        tool_name: data.tool_name,
        tool_input: data.tool_input ?? null,
        tool_response: data.tool_response ?? null,
        cwd: data.cwd ?? null,
        platformSource,
        agentId: data.agentId ?? null,
        agentType: data.agentType ?? null,
        toolUseId,
      },
      metadata: { compat: 'sessions/observations' },
      occurredAt: new Date(),
    };

    const result = await this.options.ingestEvents.ingestOne(input, {
      source: 'http_post_api_sessions_observations',
      apiKeyId: req.authContext?.apiKeyId ?? null,
      actorId: null,
      sourceAdapter: COMPAT_SOURCE_ADAPTER,
    }, dataPool);
    // Legacy response shape — older clients only check `status`.
    res.json({
      status: 'queued',
      observationCount: 1,
      sessionId: session.id,
      serverSessionId: session.id,
      eventId: result.event.id,
      generationJobId: result.outbox?.id ?? null,
      transport: result.enqueueState,
    });
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }
}

/**
 * Look up an existing server_session by platform-scoped
 * (project, team, externalSessionId) or create one if missing. Idempotent:
 * re-issuing for the same platform/content session returns the existing row.
 *
 * Concurrent compat callers can race here — both observe `existing===null`
 * and both call `repo.create`, where the second will hit one of two unique
 * constraints (`(project_id, idempotency_key)` covered by ON CONFLICT, or a
 * platform-scoped external_session_id index). Catch the unique-violation and
 * re-fetch so the caller never sees a 500.
 */
export async function resolveServerSession(input: {
  pool: PostgresPool;
  teamId: string;
  projectId: string;
  contentSessionId: string;
  platformSource: string | null;
  agentId: string | null;
  agentType: string | null;
}): Promise<{ id: string; projectId: string; teamId: string }> {
  const repo = new PostgresServerSessionsRepository(input.pool);
  const platformSource = input.platformSource
    ? normalizePlatformSource(input.platformSource)
    : null;
  const existing = await repo.findByExternalIdForScope({
    externalSessionId: input.contentSessionId,
    projectId: input.projectId,
    teamId: input.teamId,
    platformSource,
  });
  if (existing) {
    return { id: existing.id, projectId: existing.projectId, teamId: existing.teamId };
  }
  const createInput = {
    projectId: input.projectId,
    teamId: input.teamId,
    externalSessionId: input.contentSessionId,
    contentSessionId: input.contentSessionId,
    agentId: input.agentId,
    agentType: input.agentType,
    platformSource,
  };
  try {
    const created = await repo.create(createInput);
    return { id: created.id, projectId: created.projectId, teamId: created.teamId };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Postgres unique_violation. A concurrent compat call inserted the row
    // for this platform-scoped external session before we could; re-fetch and
    // return that row instead of bubbling a 500 to the legacy client.
    if ((err as Error & { code?: string }).code === '23505') {
      const racedRow = await repo.findByExternalIdForScope({
        externalSessionId: input.contentSessionId,
        projectId: input.projectId,
        teamId: input.teamId,
        platformSource,
      });
      if (racedRow) {
        return { id: racedRow.id, projectId: racedRow.projectId, teamId: racedRow.teamId };
      }
    }
    throw error;
  }
}
