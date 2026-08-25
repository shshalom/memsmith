// SPDX-License-Identifier: Apache-2.0

import type { Application, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import type { RouteHandler } from '../../../services/server/Server.js';
import { CreateAgentEventSchema } from '../../../core/schemas/agent-event.js';
import type { PostgresPool } from '../../../storage/postgres/pool.js';
import {
  PostgresAgentEventsRepository,
  type CreatePostgresAgentEventInput,
  type PostgresAgentEvent,
} from '../../../storage/postgres/agent-events.js';
import {
  PostgresObservationGenerationJobEventsRepository,
  PostgresObservationGenerationJobRepository,
  type PostgresObservationGenerationJob,
} from '../../../storage/postgres/generation-jobs.js';
import { PostgresAuthRepository } from '../../../storage/postgres/auth.js';
import { PostgresObservationRepository, mapObservationRow, type ObservationRow, type PostgresObservation } from '../../../storage/postgres/observations.js';
import { PostgresProjectsRepository } from '../../../storage/postgres/projects.js';
import { logger } from '../../../utils/logger.js';
import { requirePostgresServerAuth, requireRole, requireWriteRole, roleSatisfies } from '../../middleware/postgres-auth.js';
import { evaluateOwnerBootstrap } from './owner-bootstrap.js';
import { withPostgresTransaction } from '../../../storage/postgres/pool.js';
import type { PostgresRequireAuthOptions } from '../../middleware/postgres-auth.js';
import { authorizeObservationDelete } from './delete-authorization.js';
import { PostgresTeamsRepository, type PostgresTeamRole } from '../../../storage/postgres/teams.js';
import { PostgresDataDeletionRepository } from '../../../storage/postgres/data-deletion.js';
import { requestIdMiddleware } from '../../middleware/request-id.js';
import type { ActiveServerQueueManager } from '../../runtime/ActiveServerQueueManager.js';
import type { ServerQueueManager } from '../../runtime/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRecallMcpServer, type RecallBackend } from '../../mcp/recall-mcp-server.js';
import { requireRateLimit, requireMonthlyQuota } from '../../middleware/rate-limit.js';
import { meterRequests } from '../../middleware/usage-metering.js';
import { PostgresUsageRepository } from '../../../storage/postgres/usage.js';
import { createHash, randomBytes } from 'node:crypto';
import { PostgresServerSessionsRepository } from '../../../storage/postgres/server-sessions.js';
import { IngestEventsService, type EnqueueOutcome } from '../../services/IngestEventsService.js';
import { EndSessionService } from '../../services/EndSessionService.js';
import { normalizePlatformSource, normalizePlatformSourceOrNull } from '../../../shared/platform-source.js';
import { resolveHeads } from '../../retrieval/supersession.js';
import { recordServedCompression } from '../../retrieval/recordServedCompression.js';
import { ObservationStream } from './ObservationStream.js';
import type { SettingsResolver } from '../../settings/SettingsResolver.js';
import type { SettingsStore } from '../../settings/SettingsStore.js';
import { registerSettingsRoutes, registerIdentityRoutes, registerProjectsRoutes } from './settingsRoutes.js';
import { CredentialStore } from '../../../services/identity/credential-store.js';
import { scrubEventPayload } from '../../services/event-payload-scrub.js';
import { embedForPersist } from '../../generation/embed-for-persist.js';
import { boostUserDirected } from './user-note-boost.js';
import { scoreSubmittedObservation, meetsFloor, isExemptUserNote } from './ingest-quality.js';
import { classifyAndComposeRecordIntent } from './record-intent.js';
import { stripMemoryTags } from '../../../utils/tag-stripping.js';
import { providerComplete } from '../../generation/provider-complete.js';
import type { GenerationProviderHolder } from '../../generation/GenerationProviderHolder.js';
import { stampAttribution } from './attribution.js';
import { registerConvertRoutes } from './ConvertRoutes.js';
import { registerConvertImportRoutes } from './ConvertImportRoutes.js';
import { hashApiKey } from '../../../services/hooks/server-bootstrap.js';
import { registerJoinRegisterRoute } from './JoinRegisterRoute.js';
import { requireJoinRateLimit } from '../../middleware/join-rate-limit-subject.js';
import { makeHttpsJoinTransport } from '../../convert/join-transport-https.js';
import { probeConnection, makeRealProbeDeps } from '../../convert/connection-probe.js';
import { applyPgvectorFix } from '../../convert/apply-fix.js';
import { runConvert } from '../../convert/convert-service.js';
import { ensureBaseKey, upsertTeamAndProject, writeProjectRuntime, PROJECT_PATH_KEY } from '../../../services/identity/project-identity.js';
import { bootstrapServerPostgresSchema } from '../../../storage/postgres/schema.js';
import { parsePostgresConfig } from '../../../storage/postgres/config.js';
import { createPostgresPool } from '../../../storage/postgres/pool.js';
import type { CopyDeps } from '../../convert/copy-engine.js';
import { ensureRemoteTeamHinge } from '../../convert/team-hinge.js';
import {
  discoverGeneratedColumns, stripGeneratedColumns, type GeneratedColumnMap,
} from '../../convert/generated-columns.js';
import { buildScopedReadQuery, buildScopedCountQuery, restampTeamId } from './convert-scope.js';
import { deriveServerUrl } from '../../convert/convert-context.js';
import { recordPendingJoin, clearPendingJoin } from '../../convert/pending-join.js';
import { applyConvertJoin } from '../../convert/apply-join.js';
import { shareMarkerInGit } from '../../convert/share-marker.js';
import { summariseLocalApply } from '../../convert/local-apply-report.js';
import { resolveConvertServerUrl } from '../../convert/resolve-convert-server-url.js';
import { repointLocalKeyToTeam, repointProjectDatabaseTeam } from '../../convert/repoint-local-key.js';
import { listTeamProjects, readAcrossTeam, mergeTeamResults } from '../../retrieval/team-scope.js';
import { resolveProjectRuntime } from './project-runtime.js';
import { readProjectMarker as readProjectMarkerForRuntime } from '../../../services/identity/project-identity.js';
import type { PoolRegistry } from '../../../storage/postgres/pool-registry.js';
import { resolveRequestDatabase } from '../../middleware/resolve-request-database.js';
import { projectDatabaseName } from '../../runtime/resolve-project-database.js';

const SOURCE_ADAPTER_DEFAULT = 'api';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const MCP_SERVER_VERSION =
  typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// The MCP link base: MEMSMITH_PUBLIC_URL in prod (behind a proxy/LB), else
// derived from the request host so the connect command points at this server.
function mcpConnectUrl(req: Request): string {
  const base = (process.env.MEMSMITH_PUBLIC_URL ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`)
    .replace(/\/+$/, '');
  return `${base}/v1/mcp`;
}
function mcpConnectCommand(mcpUrl: string, key: string): string {
  return `claude mcp add --transport http memsmith ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}

export interface ServerV1PostgresRoutesOptions {
  pool: PostgresPool;
  queueManager: ServerQueueManager;
  authMode?: string;
  allowLocalDevBypass?: boolean;
  // Local-dev fallback team for unauthenticated loopback requests. Only
  // applied when authMode === 'local-dev' AND allowLocalDevBypass AND the
  // request is loopback — the middleware guards enforce all three conditions.
  localDevTeamId?: string | null;
  // Local-dev fallback project, parallel to localDevTeamId (same loopback +
  // local-dev gating in the middleware).
  localDevProjectId?: string | null;
  /**
   * Read-only grant for a TRACKED project — a clone of a team project whose
   * marker this machine can see but whose key it does not hold. Optional:
   * omitting it leaves auth behaviour exactly as before.
   */
  resolveTrackedView?: PostgresRequireAuthOptions['resolveTrackedView'];
  /** Forwards a JOINED project's reads to its team server. Optional. */
  teamReadProxy?: import('express').RequestHandler;
  // Queue lookup is exposed as a function so tests can swap the queue manager.
  // When the manager is the disabled adapter, enqueue is silently skipped and
  // the outbox row stays in `queued` state for startup reconciliation to
  // pick up — never claim observations were generated.
  getEventQueue?: () => ReturnType<ActiveServerQueueManager['getQueue']> | null;
  getSummaryQueue?: () => ReturnType<ActiveServerQueueManager['getQueue']> | null;
  // Task 8 — settings control panel. Both are optional so existing tests that
  // construct ServerV1PostgresRoutes without them continue to compile and run;
  // when absent the /v1/settings routes are simply not registered.
  settingsResolver?: SettingsResolver;
  settingsStore?: SettingsStore;
  // Task 4 — identity surface. Optional so existing tests compile without it;
  // when absent, /v1/identity still registers but uses the default CredentialStore.
  credentialStore?: CredentialStore;
  // Task 8 (record-intent) — generation provider holder for the record-intent
  // backstop endpoint. Optional: when absent the endpoint is still registered
  // but the classify+compose call will receive a null provider and fail-open
  // (recorded: false) without a 500.
  generationProviderHolder?: GenerationProviderHolder;
  // Task 5 — per-request database routing (per-project-database design).
  // Optional: when absent, resolveRequestDatabase is never mounted and every
  // DATA-table query falls back to `req.databasePool ?? this.options.pool`
  // (i.e. the base pool) — this is what keeps every existing pool-less test
  // and any deployment without MEMSMITH_SERVER_DATABASE_URL unchanged.
  poolRegistry?: PoolRegistry;
  baseDatabaseName?: string;
  baseProjectId?: string | null;
}

interface BatchPreValidationFailure {
  status: number;
  body: { error: string; message: string };
}

const EVENT_QUERY_SCHEMA = z.object({
  generate: z.union([z.literal('true'), z.literal('false')]).optional(),
  wait: z.union([z.literal('true'), z.literal('false')]).optional(),
});

// `?wait=true` polls the outbox row until it reaches a terminal status
// (`completed` / `failed` / `cancelled`). Hard-capped so a stuck provider can
// never block an HTTP worker indefinitely; callers always get a response.
const WAIT_TIMEOUT_MS = 30_000;
const WAIT_POLL_INTERVAL_MS = 100;
const TERMINAL_JOB_STATUSES: readonly PostgresObservationGenerationJob['status'][] = [
  'completed',
  'failed',
  'cancelled',
];

async function waitForTerminalJob(
  jobRepo: PostgresObservationGenerationJobRepository,
  job: PostgresObservationGenerationJob,
  timeoutMs: number = WAIT_TIMEOUT_MS,
  intervalMs: number = WAIT_POLL_INTERVAL_MS,
): Promise<{ job: PostgresObservationGenerationJob; timedOut: boolean }> {
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    return { job, timedOut: false };
  }
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const refreshed = await jobRepo.getByIdForScope({
      id: job.id,
      projectId: job.projectId,
      teamId: job.teamId,
    });
    if (!refreshed) {
      return { job: current, timedOut: false };
    }
    current = refreshed;
    if (TERMINAL_JOB_STATUSES.includes(refreshed.status)) {
      return { job: refreshed, timedOut: false };
    }
  }
  return { job: current, timedOut: true };
}

export class ServerV1PostgresRoutes implements RouteHandler {
  private readonly ingestEvents: IngestEventsService;
  private readonly endSession: EndSessionService;

  /**
   * The tracked-view resolver this instance was configured with, exposed so the
   * server can register it PROCESS-WIDE (setTrackedViewResolver).
   *
   * Nine separate call sites construct auth middleware — these routes,
   * /v1/identity's own, the dashboard routes, two compat adapters. Wiring the
   * resolver into each by hand missed the dashboard twice, which made the UI
   * render "Not authenticated" for a tracked project instead of showing Join.
   */
  get trackedViewResolver(): ServerV1PostgresRoutesOptions['resolveTrackedView'] {
    return this.options.resolveTrackedView;
  }

  constructor(private readonly options: ServerV1PostgresRoutesOptions) {
    this.ingestEvents = new IngestEventsService({
      pool: options.pool,
      resolveEventQueue: () => this.resolveQueue('event') as never,
    });
    this.endSession = new EndSessionService({
      pool: options.pool,
      resolveSummaryQueue: () => this.resolveQueue('summary') as never,
    });
  }

  /**
   * Expose the shared services so other route handlers (e.g. the legacy
   * compat adapters in src/server/compat) can call the EXACT same code path
   * — never duplicate ingest/end logic across routes.
   */
  getIngestEventsService(): IngestEventsService {
    return this.ingestEvents;
  }

  getEndSessionService(): EndSessionService {
    return this.endSession;
  }

  setupRoutes(app: Application): void {
    // Phase 12 — request_id middleware MUST run before auth so the audit log
    // can carry a stable correlation id across "rejected at auth" and
    // "ingested" code paths. requestIdMiddleware is idempotent (it honors
    // an inbound X-Request-Id header) so registering it multiple times for
    // overlapping route trees would still produce one canonical id per req.
    app.use('/v1', requestIdMiddleware());
    // TEAM READS GO TO THE TEAM — /v1 too, not just /dashboard. The Observations
    // tab POSTs to /v1/search, so mounting the proxy only under /dashboard left
    // that tab empty for a joined project while the metrics tile showed the
    // team's rows: a dashboard reporting counts it could not display.
    //
    // Before auth, deliberately: a joined project's request carries a
    // team-issued credential this server cannot validate. The proxy itself
    // forwards only an explicit allow-list of read paths.
    if (this.options.teamReadProxy) {
      app.use('/v1', this.options.teamReadProxy);
    }
    const baseWrite = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId,
      localDevProjectId: this.options.localDevProjectId,
      requiredScopes: ['memories:write'],
    });
    const baseRead = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId,
      localDevProjectId: this.options.localDevProjectId,
      // Read-only tracked view applies to READS only; baseWrite deliberately
      // omits it, so a write route can never take this branch.
      resolveTrackedView: this.options.resolveTrackedView,
      requiredScopes: ['memories:read'],
    });
    // Paid-readiness guards, all opt-in via env so default behavior is unchanged
    // (empty array → readAuth/writeAuth are just the base auth). Express accepts
    // a middleware array wherever a single handler goes, so the per-route
    // registrations below need no changes. Order after auth: rate limit → quota
    // → meter, so the request is counted only once it's admitted.
    const guards: RequestHandler[] = [];
    const ratePerMin = Number(process.env.MEMSMITH_RATE_LIMIT_PER_MIN ?? '0');
    if (ratePerMin > 0) guards.push(requireRateLimit(this.options.pool, { windowSec: 60, max: ratePerMin }));
    const monthlyCap = Number(process.env.MEMSMITH_MONTHLY_REQUEST_CAP ?? '0');
    if (monthlyCap > 0) guards.push(requireMonthlyQuota(this.options.pool, { kind: 'request', cap: monthlyCap }));
    if (process.env.MEMSMITH_USAGE_METERING === '1') guards.push(meterRequests(this.options.pool));
    // A monthly TOKEN cap gates writes only (ingestion drives generation = token
    // spend); reads stay available so a team over budget can still recall.
    const writeGuards: RequestHandler[] = [...guards];
    const tokenCap = Number(process.env.MEMSMITH_MONTHLY_TOKEN_CAP ?? '0');
    if (tokenCap > 0) writeGuards.push(requireMonthlyQuota(this.options.pool, { kind: 'tokens', cap: tokenCap }));
    // Task 5 — per-request database routing. Mounted AFTER the auth middleware
    // above (which populates req.authContext) and BEFORE any data handler, so
    // req.databasePool is always resolved before a handler runs. Only mounted
    // when a registry was actually constructed (see ServerV1PostgresRoutesOptions
    // doc) — without one, every DATA-site fallback (`req.databasePool ??
    // this.options.pool`) resolves to the base pool exactly as before this task.
    const dbRouting: RequestHandler[] = this.options.poolRegistry
      ? [resolveRequestDatabase(this.options.poolRegistry, {
          baseDatabaseName: this.options.baseDatabaseName ?? 'postgres',
          baseProjectId: this.options.baseProjectId ?? null,
        })]
      : [];
    const writeAuth: RequestHandler[] = [baseWrite, ...dbRouting, ...writeGuards];
    const readAuth: RequestHandler[] = [baseRead, ...dbRouting, ...guards];

    // GET /v1/usage — per-kind usage totals for the caller's team this month.
    app.get('/v1/usage', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      const usage = await new PostgresUsageRepository(this.options.pool).summarize({ teamId, since: monthStart });
      res.status(200).json({ since: monthStart.toISOString(), usage });
    }));

    // POST /v1/keys — mint a READ-ONLY, optionally-expiring API key for the
    // caller's team and return the ready-to-paste connect command. Gated by
    // writeAuth: minting a lesser (read) key requires you can already write the
    // team's memory, which avoids a read key escalating into more keys. The raw
    // key is shown exactly once.
    // POST /v1/teams/:teamId/bootstrap-owner — the ONE role-gated escape hatch.
    //
    // Without it a user cannot use their own team: convert calls
    // /v1/convert/register-key (requireRole('owner')), their team key has no
    // team_members row on the remote so its role is null, and minting a
    // role-bearing key needs `admin` which needs a role-bearing key. The only
    // existing way out is a CLI that talks straight to Postgres — VPN or an
    // in-VPC task against a private RDS. A user must not need AWS access to use
    // their own team.
    //
    // Deliberately NOT role-gated (that is the point) and deliberately NOT part
    // of writeAuth's chain: the decision lives in evaluateOwnerBootstrap, which
    // gates on an operator flag (default OFF) and a window from team creation.
    // See that file for what ownership actually grants — it is a real
    // escalation, including DELETE /v1/projects/:id/memory.
    // Two shapes, one handler. `:teamId` is explicit; `/v1/teams/bootstrap-owner`
    // lets the caller say "the team this key belongs to" — which is the only
    // thing a converting client actually knows. It holds a destination team KEY,
    // not that team's id (the id it has is its LOCAL team), so demanding the id
    // in the path would have made the retry 403 every time on a mismatch it
    // could not avoid.
    const bootstrapOwnerHandler = this.asyncHandler(async (req, res) => {
      const ctxTeamId = (req as unknown as { authContext?: { teamId?: string | null } }).authContext?.teamId ?? '';
      const requestedTeamId = String((req.params as { teamId?: string }).teamId ?? '') || String(ctxTeamId);
      const ctx = (req as unknown as { authContext?: { teamId?: string | null; apiKeyId?: string | null } }).authContext;
      const enabled = process.env.MEMSMITH_ALLOW_OWNER_BOOTSTRAP === '1';
      const windowMinutes = Number(process.env.MEMSMITH_OWNER_BOOTSTRAP_WINDOW_MINUTES ?? 60);

      // Read the key's own row: authContext carries teamId but not user_id, and
      // user_id is what the membership insert and the role join both need.
      let keyUserId: string | null = null;
      let teamCreatedAtEpoch: number | null = null;
      let teamHasOwner = false;
      try {
        if (ctx?.apiKeyId) {
          const k = await this.options.pool.query(
            'SELECT user_id FROM api_keys WHERE id = $1 LIMIT 1', [ctx.apiKeyId],
          );
          keyUserId = (k.rows[0] as { user_id?: string | null } | undefined)?.user_id ?? null;
        }
        const t = await this.options.pool.query(
          'SELECT created_at FROM teams WHERE id = $1 LIMIT 1', [requestedTeamId],
        );
        const created = (t.rows[0] as { created_at?: Date | string | null } | undefined)?.created_at;
        if (created) teamCreatedAtEpoch = new Date(created).getTime();
        const o = await this.options.pool.query(
          "SELECT 1 FROM team_members WHERE team_id = $1 AND role = 'owner' LIMIT 1",
          [requestedTeamId],
        );
        teamHasOwner = (o.rowCount ?? 0) > 0;
      } catch {
        // Fail closed: an unreadable state must not be read as "safe to grant".
        res.status(410).json({ error: 'Gone', message: 'the setup window for this team cannot be verified' });
        return;
      }

      const decision = evaluateOwnerBootstrap({
        enabled, windowMinutes, now: Date.now(), teamCreatedAtEpoch,
        requestedTeamId, keyTeamId: ctx?.teamId ?? null, keyUserId, teamHasOwner,
      });
      if (decision.outcome !== 'grant') {
        // Label must match the status. A 404 reported as "Forbidden" tells a
        // caller the endpoint exists and is merely closed to them, which is
        // exactly what the disabled case is trying not to reveal.
        const label = decision.status === 404 ? 'NotFound'
          : decision.status === 409 ? 'Conflict'
          : decision.status === 410 ? 'Gone'
          : 'Forbidden';
        res.status(decision.status).json({ error: label, message: decision.message });
        return;
      }

      // ONE transaction. The re-check inside it with FOR UPDATE is what makes
      // two concurrent bootstraps resolve to one owner — a check-then-act
      // without the lock is the race createMarkerIfAbsent already documents
      // losing.
      try {
        await withPostgresTransaction(this.options.pool, async (tx) => {
          const guard = await tx.query(
            "SELECT 1 FROM team_members WHERE team_id = $1 AND role = 'owner' FOR UPDATE",
            [requestedTeamId],
          );
          if ((guard.rowCount ?? 0) > 0) throw new Error('already-owned');
          if (decision.stampKeyUserId && ctx?.apiKeyId) {
            await tx.query(
              'UPDATE api_keys SET user_id = $1 WHERE id = $2 AND user_id IS NULL',
              [decision.userId, ctx.apiKeyId],
            );
          }
          await tx.query(
            `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')
             ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner'`,
            [requestedTeamId, decision.userId],
          );
        });
      } catch (error) {
        const raced = error instanceof Error && error.message === 'already-owned';
        res.status(raced ? 409 : 500).json({
          error: raced ? 'Conflict' : 'InternalError',
          message: raced
            ? 'this team already has an owner — ask them to grant you access'
            : 'could not establish ownership',
        });
        return;
      }

      logger.info('HTTP', 'owner bootstrapped', { teamId: requestedTeamId, userId: decision.userId });
      res.status(200).json({ userId: decision.userId, role: 'owner' });
    });
    app.post('/v1/teams/bootstrap-owner', ...readAuth, bootstrapOwnerHandler);
    app.post('/v1/teams/:teamId/bootstrap-owner', ...readAuth, bootstrapOwnerHandler);

    app.post('/v1/keys', writeAuth, requireRole('admin'), this.handleCreate(
      z.object({
        label: z.string().max(120).optional(),
        expiresInDays: z.number().int().positive().max(365).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        const raw = `cm_${randomBytes(24).toString('hex')}`;
        const keyHash = createHash('sha256').update(raw).digest('hex');
        const expiresAt = body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 86_400_000)
          : null;
        const key = await new PostgresAuthRepository(this.options.pool).createApiKey({
          keyHash,
          teamId,
          projectId: req.authContext?.projectId ?? null,
          actorId: req.authContext?.apiKeyId ?? 'api',
          scopes: ['memories:read'],
          expiresAt,
        });
        void body.label; // reserved for when api_keys grows a label column
        const mcpUrl = mcpConnectUrl(req);
        res.status(201).json({
          id: key.id,
          apiKey: raw, // shown ONCE — store it now
          scopes: ['memories:read'],
          expiresAt: expiresAt?.toISOString() ?? null,
          mcpUrl,
          connectCommand: mcpConnectCommand(mcpUrl, raw),
        });
      },
    ));

    // GET /v1/connect — the paste-ready MCP connect command (placeholder key, so
    // a GET never mints). Use POST /v1/keys to get a real read-only key.
    app.get('/v1/connect', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const mcpUrl = mcpConnectUrl(req);
      res.status(200).json({
        mcpUrl,
        connectCommand: mcpConnectCommand(mcpUrl, '<YOUR_API_KEY>'),
        hint: 'POST /v1/keys (write scope) to mint a read-only key for this link.',
      });
    }));

    // POST /v1/events — single event with optional async generation
    app.post('/v1/events', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const parsedQuery = EVENT_QUERY_SCHEMA.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsedQuery.error.issues });
        return;
      }
      const generate = parsedQuery.data.generate !== 'false';
      const wait = parsedQuery.data.wait === 'true';

      const result = CreateAgentEventSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      const body = result.data;
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      if (!this.ensureProjectAllowed(req, res, body.projectId)) return;

      const insertInput = this.toAgentEventInput(body, teamId);
      await this.applyContentSessionLinks([insertInput], [req.body], teamId, req.databasePool ?? this.options.pool);
      let event: PostgresAgentEvent;
      let outbox: PostgresObservationGenerationJob | null = null;
      let enqueueState: EnqueueOutcome = 'skipped';
      const ingestOptions = {
        generate,
        source: 'http_post_v1_events',
        apiKeyId: req.authContext?.apiKeyId ?? null,
        actorId: await this.resolveActorId(req),
        sourceAdapter: insertInput.sourceAdapter,
        requestId: req.requestId ?? null,
      };
      try {
        const result = await this.ingestEvents.ingestOne(insertInput, ingestOptions, req.databasePool ?? this.options.pool);
        event = result.event;
        outbox = result.outbox;
        enqueueState = result.enqueueState;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'event.write ingest failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'event.write');
        return;
      }

      await this.auditWrite(req, 'event.received', event.id, event.projectId, {
        sourceAdapter: event.sourceAdapter,
        sourceEventId: event.sourceEventId,
        eventType: event.eventType,
        serverSessionId: event.serverSessionId,
        generationJobId: outbox?.id ?? null,
      });

      if (wait) {
        let resolved = outbox;
        let waitTimedOut = false;
        if (outbox) {
          const jobRepo = new PostgresObservationGenerationJobRepository(req.databasePool ?? this.options.pool);
          const result = await waitForTerminalJob(jobRepo, outbox);
          resolved = result.job;
          waitTimedOut = result.timedOut;
        }
        res.status(201).json({
          event: serializeEvent(event),
          generationJob: resolved ? serializeJobStatusResponse(resolved, enqueueState) : null,
          ...(waitTimedOut ? { waitTimedOut: true } : {}),
        });
        return;
      }

      res.status(201).json({
        event: serializeEvent(event),
        ...(outbox
          ? { generationJob: serializeGenerationJob(outbox, enqueueState) }
          : {}),
      });
    }));

    // POST /v1/events/batch — pre-validate, atomic insert, then enqueue
    app.post('/v1/events/batch', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const parsedQuery = EVENT_QUERY_SCHEMA.safeParse(req.query);
      if (!parsedQuery.success) {
        res.status(400).json({ error: 'ValidationError', issues: parsedQuery.error.issues });
        return;
      }
      const generate = parsedQuery.data.generate !== 'false';
      const wait = parsedQuery.data.wait === 'true';

      const batchSchema = z.array(CreateAgentEventSchema).min(1).max(500);
      const result = batchSchema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const failure = preValidateBatch(req, result.data);
      if (failure) {
        res.status(failure.status).json(failure.body);
        return;
      }

      const inputs = result.data.map(item => this.toAgentEventInput(item, teamId));
      await this.applyContentSessionLinks(
        inputs,
        Array.isArray(req.body) ? req.body : result.data,
        teamId,
        req.databasePool ?? this.options.pool,
      );

      let inserted: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null }[] = [];
      let enqueueResults: EnqueueOutcome[] = [];
      const batchIngestOptions = {
        generate,
        source: 'http_post_v1_events_batch',
        apiKeyId: req.authContext?.apiKeyId ?? null,
        actorId: await this.resolveActorId(req),
        // Do not pick a single adapter for the whole batch. ingestBatch
        // builds each event's BullMQ payload via buildEventBullmqPayload,
        // which falls back to event.sourceAdapter when this opt is null —
        // so a mixed batch (e.g. 'mcp' + 'api') keeps per-event metadata
        // accurate in both the persisted outbox payload and the audit row.
        sourceAdapter: null,
        requestId: req.requestId ?? null,
      };
      try {
        const ingested = await this.ingestEvents.ingestBatch(inputs, batchIngestOptions, req.databasePool ?? this.options.pool);
        inserted = ingested.map(({ event, outbox }) => ({ event, outbox }));
        enqueueResults = ingested.map(({ enqueueState }) => enqueueState);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'event.batch_write ingest failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'event.batch_write');
        return;
      }

      await this.auditWrite(req, 'event.batch_received', null, null, {
        eventCount: inserted.length,
        generationJobIds: inserted.map(({ outbox }) => outbox?.id ?? null).filter(Boolean),
      });

      if (wait) {
        const jobRepo = new PostgresObservationGenerationJobRepository(req.databasePool ?? this.options.pool);
        const waitDeadline = Date.now() + WAIT_TIMEOUT_MS;
        const resolved: { event: PostgresAgentEvent; outbox: PostgresObservationGenerationJob | null; timedOut: boolean }[] = [];
        for (const item of inserted) {
          if (!item.outbox) {
            resolved.push({ event: item.event, outbox: null, timedOut: false });
            continue;
          }
          const remaining = Math.max(0, waitDeadline - Date.now());
          const result = await waitForTerminalJob(jobRepo, item.outbox, remaining);
          resolved.push({ event: item.event, outbox: result.job, timedOut: result.timedOut });
        }
        const anyTimedOut = resolved.some(r => r.timedOut);
        res.status(201).json({
          events: resolved.map(({ event, outbox, timedOut }, index) => ({
            event: serializeEvent(event),
            generationJob: outbox
              ? serializeJobStatusResponse(outbox, enqueueResults[index]!)
              : null,
            ...(timedOut ? { waitTimedOut: true } : {}),
          })),
          ...(anyTimedOut ? { waitTimedOut: true } : {}),
        });
        return;
      }

      res.status(201).json({
        events: inserted.map(({ event, outbox }, index) => ({
          event: serializeEvent(event),
          ...(outbox
            ? { generationJob: serializeGenerationJob(outbox, enqueueResults[index]!) }
            : {}),
        })),
      });
    }));

    // GET /v1/events/:id — scoped read
    app.get('/v1/events/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const eventsRepo = new PostgresAgentEventsRepository(req.databasePool ?? this.options.pool);
      const fullEvent = await this.loadScopedById(req, res, {
        id,
        teamId,
        table: 'agent_events',
        notFound: 'Event not found',
        load: (projectId) => eventsRepo.getByIdForScope({ id, projectId, teamId }),
      });
      if (!fullEvent) return;
      res.json({ event: serializeEvent(fullEvent) });
    }));

    // GET /v1/events/:id/observations — list observations linked to event via observation_sources.
    // Scope is enforced by joining observations.team_id = $teamId and the
    // event ownership check before any rows are returned. Cross-tenant
    // requests are reported as 404 to avoid revealing existence.
    app.get('/v1/events/:id/observations', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const dataPool = req.databasePool ?? this.options.pool;

      const eventResult = await dataPool.query(
        `SELECT id, project_id FROM agent_events WHERE id = $1 AND team_id = $2`,
        [id, teamId],
      );
      const eventRow = eventResult.rows[0] as undefined | { id: string; project_id: string };
      if (!eventRow) {
        res.status(404).json({ error: 'NotFound', message: 'Event not found' });
        return;
      }
      if (!this.ensureProjectAllowed(req, res, eventRow.project_id)) return;

      const obsResult = await dataPool.query(
        `
          SELECT o.id, o.project_id, o.team_id, o.server_session_id, o.kind, o.content,
                 o.metadata, o.generation_key, o.created_by_job_id, o.created_at, o.updated_at,
                 os.id AS source_id_pk, os.source_type, os.source_id, os.generation_job_id, os.created_at AS source_created_at
          FROM observation_sources os
          INNER JOIN observations o ON o.id = os.observation_id
          WHERE os.source_type = 'agent_event'
            AND os.source_id = $1
            AND o.team_id = $2
            AND o.project_id = $3
          ORDER BY o.created_at ASC
        `,
        [eventRow.id, teamId, eventRow.project_id],
      );

      await this.auditWrite(req, 'observation.read', eventRow.id, eventRow.project_id, {
        mode: 'event_observations',
        eventId: eventRow.id,
        resultCount: obsResult.rows.length,
        observationIds: obsResult.rows.map(r => r.id),
      });

      res.json({
        eventId: eventRow.id,
        observations: obsResult.rows.map(serializeObservationWithSource),
      });
    }));

    // Phase 11 — team-scoped queue listing. The api key MUST be bound to this
    // team OR a project owned by this team. We never let a project-scoped key
    // read a sibling project's jobs even if it has team-level read scope, so
    // we fall through to a project-only filter when projectId is set on the
    // key. Cross-team requests return 404 to avoid leaking team existence.
    app.get('/v1/teams/:teamId/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const callerTeamId = this.requireTeamId(req, res);
      if (!callerTeamId) return;
      const targetTeamId = this.routeParam(req.params.teamId);
      if (!targetTeamId) {
        res.status(400).json({ error: 'ValidationError', message: 'teamId required' });
        return;
      }
      if (targetTeamId !== callerTeamId) {
        // Don't leak existence — return 404 not 403.
        res.status(404).json({ error: 'NotFound', message: 'Team not found' });
        return;
      }
      const callerProjectId = req.authContext?.projectId ?? null;
      const { status, limit, offset } = parseJobListingQuery(req);
      let jobs: JobListRow[] = [];
      let total = 0;
      try {
        ({ jobs, total } = await this.listJobsForScope({
          teamId: callerTeamId,
          projectId: callerProjectId,
          status,
          limit,
          offset,
        }, req.databasePool ?? this.options.pool));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'team.jobs.list query failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'team.jobs.list');
        return;
      }
      await this.auditWrite(req, 'observation.read', null, callerProjectId, {
        mode: 'team_jobs',
        teamId: callerTeamId,
        projectId: callerProjectId,
        status,
        limit,
        offset,
        resultCount: jobs.length,
      });
      res.status(200).json({
        jobs: jobs.map(row => serializeJobListEntry(row)),
        total,
        limit,
        offset,
      });
    }));

    // Phase 11 — project-scoped queue listing. Project-scoped api keys MAY
    // read this; team-scoped keys MAY read any project under their team.
    // Cross-tenant requests are reported as 404, matching the rest of the
    // routes so existence is never inferable from response status.
    app.get('/v1/projects/:projectId/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const projectId = this.routeParam(req.params.projectId);
      if (!projectId) {
        res.status(400).json({ error: 'ValidationError', message: 'projectId required' });
        return;
      }
      // Verify the project actually belongs to this team. Cross-team
      // requests must look identical to "no such project" responses.
      const projectResult = await this.options.pool.query<{ id: string }>(
        'SELECT id FROM projects WHERE id = $1 AND team_id = $2',
        [projectId, teamId],
      );
      if (projectResult.rows.length === 0) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' });
        return;
      }
      // Project-scoped key must match the requested project; team-scoped key
      // (no projectId on the key) is allowed.
      const callerProjectId = req.authContext?.projectId ?? null;
      if (callerProjectId && callerProjectId !== projectId) {
        res.status(404).json({ error: 'NotFound', message: 'Project not found' });
        return;
      }

      const { status, limit, offset } = parseJobListingQuery(req);
      let jobs: JobListRow[] = [];
      let total = 0;
      try {
        ({ jobs, total } = await this.listJobsForScope({
          teamId,
          projectId,
          status,
          limit,
          offset,
        }, req.databasePool ?? this.options.pool));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'project.jobs.list query failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'project.jobs.list');
        return;
      }
      await this.auditWrite(req, 'observation.read', null, projectId, {
        mode: 'project_jobs',
        teamId,
        projectId,
        status,
        limit,
        offset,
        resultCount: jobs.length,
      });
      res.status(200).json({
        jobs: jobs.map(row => serializeJobListEntry(row)),
        total,
        limit,
        offset,
      });
    }));

    // Phase 12 — GET /v1/jobs (generic, scoped). Project-scoped key sees its
    // project's jobs; team-scoped key sees the team's jobs. Filters: status,
    // source_type, limit, offset, since (ISO timestamp on created_at). The
    // BullMQ payload column is NEVER returned by default — even with admin
    // scope, the caller MUST opt in via `?include=payload`. This anti-pattern
    // guard prevents accidental exfil of sensitive event payloads.
    app.get('/v1/jobs', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const callerProjectId = req.authContext?.projectId ?? null;
      const includeRaw = typeof req.query.include === 'string' ? req.query.include : '';
      const includePayload = includeRaw.split(',').map(p => p.trim()).includes('payload');
      const callerScopes = req.authContext?.scopes ?? [];
      const isAdmin = callerScopes.includes('*') || callerScopes.includes('admin')
        || callerScopes.includes('memories:admin');
      if (includePayload && !isAdmin) {
        // Anti-pattern guard: refuse the include=payload elevation without
        // admin scope. Returning 403 (not silently stripping) makes the
        // attempted privilege escalation visible in the audit chain.
        res.status(403).json({
          error: 'Forbidden',
          message: '`include=payload` requires admin scope',
        });
        return;
      }
      const { status, sourceType, limit, offset, since } = parseGenericJobListingQuery(req);
      let jobs: JobListRow[] = [];
      let total = 0;
      try {
        ({ jobs, total } = await this.listJobsForScope({
          teamId, projectId: callerProjectId, status, sourceType, limit, offset, since,
        }, req.databasePool ?? this.options.pool));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'jobs.list query failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'jobs.list');
        return;
      }
      await this.auditWrite(req, 'observation.read', null, callerProjectId, {
        mode: 'jobs_list',
        teamId,
        projectId: callerProjectId,
        status,
        sourceType,
        limit,
        offset,
        since: since ? since.toISOString() : null,
        resultCount: jobs.length,
        includePayload,
        requestId: req.requestId ?? null,
      });
      res.status(200).json({
        jobs: jobs.map(row => serializeJobListEntry(row, { includePayload })),
        total,
        limit,
        offset,
        requestId: req.requestId ?? null,
      });
    }));

    // GET /v1/jobs/:id — generation job status, scoped to team/project
    app.get('/v1/jobs/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const repo = new PostgresObservationGenerationJobRepository(req.databasePool ?? this.options.pool);
      const job = await this.loadScopedById(req, res, {
        id,
        teamId,
        table: 'observation_generation_jobs',
        notFound: 'Generation job not found',
        scopeMismatch: 'not-found',
        load: (projectId) => repo.getByIdForScope({ id, projectId, teamId }),
      });
      if (!job) return;
      res.json({ generationJob: serializeGenerationJobStatus(job) });
    }));

    // Phase 12 — POST /v1/jobs/:id/retry. Idempotent operator action: if the
    // job is already queued the call is a no-op (no second BullMQ job is
    // enqueued). On failed/cancelled rows, transition back to queued, clear
    // locked_at/locked_by/failed_at/cancelled_at/last_error, increment a
    // retried_count metadata field for audit, and re-enqueue. The Phase 11
    // outbox idempotency key (team_id, project_id, source_type, source_id,
    // job_type) prevents observation duplication on the generator side.
    app.post('/v1/jobs/:id/retry', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.retryGenerationJob(req, res, id, teamId);
      if (!result) return;
      res.status(200).json({
        generationJob: serializeGenerationJobStatus(result.job),
        retriedCount: result.retriedCount,
        alreadyQueued: result.alreadyQueued,
        requestId: req.requestId ?? null,
      });
    }));

    // Phase 12 — POST /v1/jobs/:id/cancel. Operator action: set status to
    // cancelled, set cancelled_at, append a lifecycle event, attempt to
    // remove the BullMQ job if still in flight. Future generator runs check
    // the Postgres status FIRST (Phase 11 lockOutbox guard) so a cancelled
    // job will never produce side effects even if BullMQ delivered it.
    app.post('/v1/jobs/:id/cancel', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const result = await this.cancelGenerationJob(req, res, id, teamId);
      if (!result) return;
      res.status(200).json({
        generationJob: serializeGenerationJobStatus(result.job),
        alreadyCancelled: result.alreadyCancelled,
        requestId: req.requestId ?? null,
      });
    }));

    // POST /v1/sessions/start — create-or-find a server_session, idempotent
    // on platform-scoped external session identity when platformSource is set.
    // Body matches the worker
    // /v1/sessions/start payload but stores into Postgres server_sessions.
    app.post('/v1/sessions/start', writeAuth, requireWriteRole(), this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        externalSessionId: z.string().min(1).optional(),
        contentSessionId: z.string().min(1).nullable().optional(),
        agentId: z.string().min(1).nullable().optional(),
        agentType: z.string().min(1).nullable().optional(),
        platformSource: z.string().min(1).nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        const repo = new PostgresServerSessionsRepository(req.databasePool ?? this.options.pool);
        const platformSource = normalizePlatformSourceOrNull(body.platformSource);
        try {
          if (body.externalSessionId) {
            const existing = await repo.findByExternalIdForScope({
              externalSessionId: body.externalSessionId,
              projectId: body.projectId,
              teamId,
              platformSource,
            });
            if (existing) {
              res.status(200).json({ session: serializeSession(existing) });
              return;
            }
          }
          const createInput = {
            projectId: body.projectId,
            teamId,
            externalSessionId: body.externalSessionId ?? null,
            contentSessionId: body.contentSessionId ?? null,
            agentId: body.agentId ?? null,
            agentType: body.agentType ?? null,
            platformSource,
            // Strip <private> from session metadata (the client sends the raw
            // prompt here) before it lands in server_sessions.
            metadata: scrubEventPayload(body.metadata ?? {}) as Record<string, unknown>,
          };
          let session;
          try {
            session = await repo.create(createInput);
          } catch (error) {
            // Concurrent /v1/sessions/start with the same externalSessionId
            // can race past the findByExternalIdForScope check; the second
            // insert can hit a platform-scoped unique constraint. Refetch and
            // return the row inserted by the winner so legacy clients never
            // see a spurious 500.
            const pgCode = error instanceof Error
              ? (error as Error & { code?: string }).code
              : (error as { code?: string } | null)?.code;
            if (body.externalSessionId && pgCode === '23505') {
              const racedRow = await repo.findByExternalIdForScope({
                externalSessionId: body.externalSessionId,
                projectId: body.projectId,
                teamId,
                platformSource,
              });
              if (racedRow) {
                res.status(200).json({ session: serializeSession(racedRow) });
                return;
              }
            }
            throw error;
          }
          await this.auditWrite(req, 'session.write', session.id, session.projectId);
          res.status(201).json({ session: serializeSession(session) });
        } catch (error) {
          this.handleDbError(error, res, 'session.write');
        }
      },
    ));

    // GET /v1/sessions/:id — scoped read, 404 cross-tenant.
    app.get('/v1/sessions/:id', readAuth, this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const repo = new PostgresServerSessionsRepository(req.databasePool ?? this.options.pool);
      const session = await this.loadScopedById(req, res, {
        id,
        teamId,
        table: 'server_sessions',
        notFound: 'Session not found',
        load: (projectId) => repo.getByIdForScope({ id, projectId, teamId }),
      });
      if (!session) return;
      res.json({ session: serializeSession(session) });
    }));

    // POST /v1/sessions/:id/end — set ended_at (idempotent), enqueue a
    // session-summary generation job. Re-ending the same session is a no-op
    // because the (team_id, project_id, source_type='session_summary',
    // source_id) UNIQUE constraint on observation_generation_jobs prevents
    // duplicate rows; the existing row is returned.
    app.post('/v1/sessions/:id/end', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = this.routeParam(req.params.id);
      const projectId = await this.loadScopedById(req, res, {
        id,
        teamId,
        table: 'server_sessions',
        notFound: 'Session not found',
        load: async (rowProjectId) => rowProjectId,
      });
      if (!projectId) return;

      let endedSession: Awaited<ReturnType<PostgresServerSessionsRepository['endSession']>> = null;
      let summaryOutbox: PostgresObservationGenerationJob | null = null;
      let enqueueState: EnqueueOutcome = 'skipped';
      const endInput = {
        sessionId: id,
        projectId,
        teamId,
        source: 'http_post_v1_sessions_end',
        apiKeyId: req.authContext?.apiKeyId ?? null,
        actorId: await this.resolveActorId(req),
        sourceAdapter: 'api',
      };
      try {
        const result = await this.endSession.end(endInput, req.databasePool ?? this.options.pool);
        endedSession = result.session;
        summaryOutbox = result.outbox;
        enqueueState = result.enqueueState;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'session.end failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'session.end');
        return;
      }

      if (!endedSession) {
        res.status(404).json({ error: 'NotFound', message: 'Session not found' });
        return;
      }

      await this.auditWrite(req, 'session.end', endedSession.id, endedSession.projectId);

      res.status(200).json({
        session: serializeSession(endedSession),
        ...(summaryOutbox
          ? { generationJob: serializeGenerationJob(summaryOutbox, enqueueState) }
          : {}),
      });
    }));

    // POST /v1/memories — direct/manual observation insertion (compat alias).
    // MUST NOT call generator and MUST NOT create outbox rows.
    app.post('/v1/memories', writeAuth, requireWriteRole(), this.handleCreate(
      z.object({
        projectId: z.string().min(1),
        serverSessionId: z.string().min(1).nullable().optional(),
        kind: z.string().min(1).optional(),
        obsType: z.string().min(1).optional(),
        content: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().min(1).optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        if (!this.ensureProjectAllowed(req, res, body.projectId)) return;
        // Local generation moved the quality bar here — see spec §5. Score is
        // ALWAYS computed server-side; a client-supplied value is ignored.
        // EXEMPTION: note_add (buildUserNoteRequest) posts kind='user_note' +
        // metadata.userDirected=true with no facts/narrative/concepts — it
        // scores ~0 and must bypass the floor, or "remember this" 422s.
        // Both conditions are required together so relabelling alone can't
        // dodge the bar.
        const md = body.metadata ?? {};
        const quality = scoreSubmittedObservation(md);
        const exempt = isExemptUserNote(body.kind, md);
        if (!exempt) {
          const floor = this.options.settingsResolver
            ? await this.options.settingsResolver.qualityFloor(teamId)
            : Number.parseInt(process.env.MEMSMITH_QUALITY_FLOOR ?? '20', 10) || 20;
          if (!meetsFloor(quality, floor)) {
            res.status(422).json({ error: 'BelowQualityFloor', quality, floor });
            return;
          }
        }
        // Embed on write so manual/direct inserts are semantically searchable,
        // same as the generation path. Best-effort (never throws); computed
        // BEFORE repo.create so a cold-start model load never holds the insert.
        const embeddingVec = await embedForPersist(body.content);
        const createInput = {
          projectId: body.projectId,
          teamId,
          serverSessionId: body.serverSessionId ?? null,
          kind: body.kind ?? 'manual',
          obsType: body.obsType ?? null,
          quality,
          content: body.content,
          metadata: stampAttribution(md, req.authContext ?? { userId: null }),
          embeddingVec,
          idempotencyKey: body.idempotencyKey ?? null,
        };
        try {
          const repo = new PostgresObservationRepository(req.databasePool ?? this.options.pool);
          const observation = await repo.create(createInput);
          await this.auditWrite(req, 'memory.write', observation.id, observation.projectId);
          res.status(201).json({ memory: serializeObservation(observation) });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn('SYSTEM', 'memory.write failed', { requestId: req.requestId ?? null }, err);
          this.handleDbError(err, res, 'memory.write');
        }
      },
    ));

    // Task 8 — POST /v1/record-intent: Layer 2 server-provider backstop.
    // Asks the generation provider "is this a record request? compose the note
    // if so," and writes a marked user_note on a positive classification with a
    // deterministic idempotency key (deduplicates vs the agent layer).
    // Fail-open: provider unavailable / null / NONE reply → {recorded:false},
    // 200. Never 500 the hot path.
    app.post('/v1/record-intent', writeAuth, requireWriteRole(), this.handleCreate(
      z.object({
        prompt: z.string().min(1),
        projectId: z.string().min(1).optional(),
      }),
      async (req, res, body) => {
        try {
          const teamId = this.requireTeamId(req, res);
          if (!teamId) return;
          const projectId = body.projectId ?? req.authContext?.projectId ?? null;
          if (!projectId) {
            res.status(400).json({ error: 'ValidationError', message: 'projectId required (no project scope on key)' });
            return;
          }
          if (!this.ensureProjectAllowed(req, res, projectId)) return;
          const provider = this.options.generationProviderHolder
            ? await this.options.generationProviderHolder.current(teamId)
            : null;
          const repo = new PostgresObservationRepository(req.databasePool ?? this.options.pool);
          const deps = {
            complete: (system: string, user: string) =>
              provider ? providerComplete({ provider, system, user }) : Promise.resolve(null),
            write: async (o: { projectId: string; teamId: string; kind: string; content: string; metadata: Record<string, unknown>; idempotencyKey: string; embeddingVec?: number[] | null }) => {
              // Embed on write so record-intent notes are semantically searchable.
              // Best-effort (embedForPersist never throws); matches /v1/memories path.
              const embeddingVec = await embedForPersist(o.content);
              const metadata = stampAttribution(o.metadata, req.authContext ?? { userId: null });
              return repo.create({ projectId: o.projectId, teamId: o.teamId, kind: o.kind, content: o.content, metadata, idempotencyKey: o.idempotencyKey, embeddingVec });
            },
            teamId,
            projectId,
          };
          // Strip <private> before classify so the LLM classifier, the
          // idempotency hash, and the stored content all receive stripped text
          // (moderation invariant: private content never reaches the LLM or DB).
          const prompt = stripMemoryTags(body.prompt);
          const result = await classifyAndComposeRecordIntent(prompt, deps);
          if (result.recorded && result.id) {
            try {
              await this.auditWrite(req, 'memory.write', result.id, projectId);
            } catch (auditErr) {
              logger.debug('SYSTEM', 'record-intent audit write failed (non-fatal)', { error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
            }
          }
          res.json({ recorded: result.recorded, content: result.content });
        } catch (error) {
          logger.warn('SYSTEM', 'record-intent backstop failed (fail-open)', {
            requestId: req.requestId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
          res.json({ recorded: false });
        }
      },
    ));

    // Phase 8 — full-text search over generated observations using the GIN
    // tsvector index. Results are ranked by ts_rank desc, then updated_at desc.
    // The MCP `observation_search` tool calls this endpoint via HTTP so the
    // single source of truth for the read path is the REST core.
    app.post('/v1/search', readAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1).optional(),
        // Empty query is allowed and means "list recent observations" (the
        // viewer's Observations tab loads with query='' before any search
        // term is typed). A non-empty query runs FTS/hybrid ranking.
        query: z.string().optional().default(''),
        limit: z.number().int().positive().max(100).optional(),
        platformSource: z.string().min(1).nullable().optional(),
        // Optional filter chips from the viewer (type / lifecycle).
        obsType: z.string().min(1).nullable().optional(),
        lifecycleState: z.string().min(1).nullable().optional(),
        // When true, restrict results to user-directed notes (kind='user_note').
        userDirected: z.boolean().optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        // Resolve effective projectId: body takes precedence over authContext.
        // In api-key mode authContext.projectId is set from the key; in local-dev
        // mode authContext.projectId is null, so callers must pass it explicitly.
        const projectId = body.projectId ?? req.authContext?.projectId ?? null;
        if (!projectId) {
          res.status(400).json({ error: 'ValidationError', message: 'projectId required (no project scope on key)' });
          return;
        }
        if (!this.ensureProjectAllowed(req, res, projectId)) return;
        const platformSource = normalizePlatformSourceOrNull(body.platformSource);
        const query = (body.query ?? '').trim();
        const limit = body.limit ?? 20;
        const obsType = body.obsType ?? null;
        const lifecycleState = body.lifecycleState ?? null;
        const userDirected = body.userDirected;
        let results;
        try {
          if (query.length === 0) {
            // No search term → list recent observations for the scope. This is
            // the Observations-tab default view (browse, not search). Type and
            // lifecycle filters are applied IN SQL (not in-memory over a recent
            // window) so a rare type like `decision` is found across the whole
            // table, not just among the most recent rows.
            // Team-wide: each project in the team contributes its own recent
            // rows, then readTeamWide re-sorts and cuts to `limit`. For a
            // single-project team this is exactly the previous single query.
            results = await this.readTeamWide(
              { projectId, teamId },
              req.databasePool ?? this.options.pool,
              limit,
              (pool, pid) => new PostgresObservationRepository(pool).listByProject({
                projectId: pid,
                teamId,
                limit,
                obsType,
                lifecycleState,
              }),
            );
          } else {
            // Hybrid (FTS+vector via RRF) is the default ranking; force plain FTS
            // with MEMSMITH_SEARCH_HYBRID=0. See resolveSearchResults.
            // Team-wide, ranked per project then merged. Each project's ranking
            // is computed against its own corpus (RRF positions are not
            // comparable across corpora), so the merge falls back to recency —
            // the honest ordering for a union of independently-ranked lists.
            results = await this.readTeamWide(
              { projectId, teamId },
              req.databasePool ?? this.options.pool,
              limit,
              (pool, pid) => this.resolveSearchResults({
                projectId: pid,
                teamId,
                query,
                limit,
                platformSource,
                mode: 'search',
                userDirected,
              }, pool),
            );
            if (obsType) results = results.filter(o => o.obsType === obsType);
            if (lifecycleState) results = results.filter(o => o.lifecycleState === lifecycleState);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn('SYSTEM', 'observation.search failed', { requestId: req.requestId ?? null }, err);
          this.handleDbError(err, res, 'observation.search');
          return;
        }
        await this.auditWrite(req, 'observation.read', null, projectId, {
          mode: query.length === 0 ? 'list_recent' : 'search',
          query,
          limit,
          platformSource,
          obsType,
          lifecycleState,
          resultCount: results.length,
          observationIds: results.map(o => o.id),
        });
        res.status(200).json({
          observations: results.map(serializeObservation),
        });
      },
    ));

    // Phase 8 — context pack: same read/ranking path as `/v1/search` (hybrid by
    // default via resolveSearchResults), but also returns a concatenated context
    // string for direct prompt injection. The MCP `observation_context` tool
    // calls this so MCP and any future REST consumer share the exact same
    // ranking and context-packing rule.
    app.post('/v1/context', readAuth, this.handleCreate(
      z.object({
        projectId: z.string().min(1).optional(),
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
        platformSource: z.string().min(1).nullable().optional(),
        // When true, restrict results to user-directed notes (kind='user_note').
        userDirected: z.boolean().optional(),
      }),
      async (req, res, body) => {
        const teamId = this.requireTeamId(req, res);
        if (!teamId) return;
        // Resolve effective projectId: body takes precedence over authContext.
        // In api-key mode authContext.projectId is set from the key; in local-dev
        // mode authContext.projectId is null, so callers must pass it explicitly.
        const projectId = body.projectId ?? req.authContext?.projectId ?? null;
        if (!projectId) {
          res.status(400).json({ error: 'ValidationError', message: 'projectId required (no project scope on key)' });
          return;
        }
        if (!this.ensureProjectAllowed(req, res, projectId)) return;
        const platformSource = normalizePlatformSourceOrNull(body.platformSource);
        let results;
        try {
          results = await this.resolveSearchResults({
            projectId,
            teamId,
            query: body.query,
            limit: body.limit ?? 10,
            platformSource,
            mode: 'context',
            userDirected: body.userDirected,
          }, req.databasePool ?? this.options.pool);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn('SYSTEM', 'observation.context failed', { requestId: req.requestId ?? null }, err);
          this.handleDbError(err, res, 'observation.context');
          return;
        }
        await recordServedCompression({
          usage: new PostgresUsageRepository(this.options.pool),
          teamId,
          projectId,
          rows: results,
          maxChars: 10000,
          maxItems: results.length,
        });
        const context = results
          .map(observation => observation.content)
          .filter(text => typeof text === 'string' && text.length > 0)
          .join('\n\n');
        await this.auditWrite(req, 'observation.read', null, projectId, {
          mode: 'context',
          query: body.query,
          limit: body.limit ?? 10,
          platformSource,
          resultCount: results.length,
          observationIds: results.map(o => o.id),
        });
        res.status(200).json({
          observations: results.map(serializeObservation),
          context,
        });
      },
    ));

    // GET /v1/stream — SSE fan-out for real-time new_observation events.
    // Uses readAuth (memories:read) so the same API key that reads search also
    // receives live updates. The client (Task 5) subscribes and renders new
    // observations as they arrive. Best-effort: the stream never blocks or
    // affects generation; a broken connection is dropped on next publish.
    // The subscription is scoped to the authenticated project, so a subscriber
    // only ever receives its own project's observations. Scope comes from
    // authContext — never from a query or body field — matching the database
    // routing invariant. Without a project identity there is nothing to scope
    // to, so the stream is refused rather than opened unfiltered.
    app.get('/v1/stream', readAuth, (req: Request, res: Response) => {
      const projectId = req.authContext?.projectId;
      const teamId = req.authContext?.teamId ?? '';
      if (!projectId) {
        res.status(400).json({ error: 'no project identity' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'initial_load' })}\n\n`);
      const unsub = ObservationStream.instance.subscribe(res, { teamId, projectId });
      req.on('close', () => { unsub(); });
    });

    // Remote authenticated MCP endpoint. The "secure MCP link" a user pastes
    // into Claude Code (or any MCP client) to recall their cloud memory:
    //   claude mcp add --transport http memsmith <base>/v1/mcp \
    //     --header "Authorization: Bearer cm_..."
    // Same readAuth (memories:read) + team/project scoping + audit trail as
    // /v1/search, reading the same rows through identical guards. The search and
    // context recall paths route through resolveSearchResults, so MCP recall uses
    // the SAME hybrid-by-default ranking as POST /v1/search and /v1/context.
    // Stateless streamable-HTTP: one transport + server per request, bound to
    // this key's team.
    const mcpHandler = this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const projectScope = req.authContext?.projectId ?? null;
      const dataPool = req.databasePool ?? this.options.pool;
      const repo = new PostgresObservationRepository(dataPool);
      const assertProjectAllowed = (projectId: string): void => {
        if (projectScope && projectScope !== projectId) {
          throw new Error('API key is scoped to a different project');
        }
      };
      const backend: RecallBackend = {
        search: async ({ projectId, query, limit }) => {
          assertProjectAllowed(projectId);
          // Same ranking as POST /v1/search — hybrid by default (see
          // resolveSearchResults), so MCP recall and REST search agree.
          const rows = await this.resolveSearchResults({ projectId, teamId, query, limit, platformSource: null, mode: 'search' }, dataPool);
          // Audit the read, same as POST /v1/search — the MCP path is no exception.
          await this.auditWrite(req, 'observation.read', null, projectId, {
            mode: 'search', via: 'mcp', query, limit,
            resultCount: rows.length, observationIds: rows.map(o => o.id),
          });
          return rows.map(serializeObservation);
        },
        context: async ({ projectId, query, limit }) => {
          assertProjectAllowed(projectId);
          const rows = await this.resolveSearchResults({ projectId, teamId, query, limit, platformSource: null, mode: 'context' }, dataPool);
          await this.auditWrite(req, 'observation.read', null, projectId, {
            mode: 'context', via: 'mcp', query, limit,
            resultCount: rows.length, observationIds: rows.map(o => o.id),
          });
          return rows.map(serializeObservation);
        },
        recent: async ({ projectId, limit }) => {
          assertProjectAllowed(projectId);
          const rows = await repo.listByProject({ projectId, teamId, limit });
          await this.auditWrite(req, 'observation.read', null, projectId, {
            mode: 'recent', via: 'mcp', limit,
            resultCount: rows.length, observationIds: rows.map(o => o.id),
          });
          return rows.map(serializeObservation);
        },
      };
      const server = createRecallMcpServer(backend, MCP_SERVER_VERSION);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    // MCP streamable-HTTP only uses POST (JSON-RPC) and GET (SSE). Scope the
    // route to those instead of app.all, so DELETE/PUT/PATCH/OPTIONS don't run
    // auth + transport only to be rejected.
    app.post('/v1/mcp', readAuth, mcpHandler);
    app.get('/v1/mcp', readAuth, mcpHandler);

    // DELETE /v1/memories/:id — forget a single observation (sources cascade).
    app.delete('/v1/memories/:id', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = String(req.params.id);
      const projectScope = req.authContext?.projectId ?? null;
      const dataPool = req.databasePool ?? this.options.pool;
      try {
        const row = await this.getObservationForDelete(id, teamId, projectScope, dataPool);
        if (!row) { res.status(404).json({ error: 'not_found' }); return; }

        const decision = authorizeObservationDelete(
          req.authContext ?? { role: null, userId: null },
          row,
        );
        if (!decision.allow) {
          const message = decision.reason === 'wrong_kind'
            ? 'members may delete only their own notes; deleting a generated observation requires admin'
            : 'members may delete only their own notes; this note belongs to another member';
          res.status(403).json({ error: 'Forbidden', message });
          return;
        }

        const deleted = await this.deleteObservationForScope(id, teamId, projectScope, dataPool);
        if (!deleted) { res.status(404).json({ error: 'not_found' }); return; }
        await this.auditWrite(req, 'observation.deleted', id, projectScope, { via: 'api' });
        res.status(200).json({ deleted: true, id });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'observation.delete failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'observation.delete');
      }
    }));

    // DELETE /v1/projects/:projectId/memory — forget EVERYTHING captured for a
    // project (observations, raw events, sessions, jobs). Keeps the project shell.
    app.delete('/v1/projects/:projectId/memory', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const projectId = String(req.params.projectId);
      if (!this.ensureProjectAllowed(req, res, projectId)) return;
      try {
        // ensureProjectAllowed only checks a key's *optional* project scope, so a
        // team-scoped key could otherwise purge any projectId. Confirm the project
        // belongs to this team before purging, and 404 if it doesn't — without this
        // a cross-team or nonexistent projectId returns 200 with zero counts,
        // misreporting an unauthorized purge as success.
        const project = await new PostgresProjectsRepository(this.options.pool).getByIdForTeam(projectId, teamId);
        if (!project) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        const counts = await new PostgresDataDeletionRepository(req.databasePool ?? this.options.pool)
          .purgeProjectMemory({ projectId, teamId });
        await this.auditWrite(req, 'project.memory_purged', projectId, projectId, { ...counts, via: 'api' });
        res.status(200).json({ purged: true, projectId, counts });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'project.purge failed', { requestId: req.requestId ?? null }, err);
        this.handleDbError(err, res, 'project.purge');
      }
    }));

    // Task 8 — GET /v1/settings + PATCH /v1/settings.
    // Only registered when the caller wired both resolver and store (production
    // ServerService.ts does; tests that omit them skip the routes cleanly).
    if (this.options.settingsResolver && this.options.settingsStore) {
      // Build per-verb auth middlewares that mirror the existing readAuth/writeAuth idiom.
      // These are registered BEFORE the route handlers via app.use so that
      // production requests are rejected at the middleware layer before the
      // handler body runs. The requireScopes shim inside registerSettingsRoutes
      // provides a secondary (synchronous) scope check that the unit test relies
      // on when it injects authContext directly without real auth.
      const settingsReadAuth = requirePostgresServerAuth(this.options.pool, {
        authMode: this.options.authMode,
        allowLocalDevBypass: this.options.allowLocalDevBypass,
        localDevTeamId: this.options.localDevTeamId,
        localDevProjectId: this.options.localDevProjectId,
        requiredScopes: ['memories:read'],
      });
      const settingsAdminAuth = requirePostgresServerAuth(this.options.pool, {
        authMode: this.options.authMode,
        allowLocalDevBypass: this.options.allowLocalDevBypass,
        localDevTeamId: this.options.localDevTeamId,
        localDevProjectId: this.options.localDevProjectId,
        requiredScopes: ['settings:admin'],
      });
      // app.use runs before any route handler registered for the same path.
      // Registering this BEFORE registerSettingsRoutes guarantees the auth
      // middleware runs first on every GET and PATCH to /v1/settings.
      app.use('/v1/settings', (req, res, next) => {
        if (req.method === 'GET') {
          settingsReadAuth(req, res, next);
        } else if (req.method === 'PATCH') {
          settingsAdminAuth(req, res, next);
        } else {
          next();
        }
      });
      registerSettingsRoutes(app, {
        resolver: this.options.settingsResolver,
        store: this.options.settingsStore,
        requireScopes: (req: Request, res: Response, needed: string): boolean => {
          // In production the auth middleware above already enforced the scope.
          // This callback is the secondary guard for unit tests that inject
          // authContext directly (bypassing real auth middleware).
          const scopes: string[] = (req as any).authContext?.scopes ?? [];
          if (scopes.includes('*') || scopes.includes(needed)) return true;
          res.status(403).json({ error: 'Forbidden', message: 'insufficient scope' });
          return false;
        },
        auditFn: this.auditWrite.bind(this),
      });
    }

    // Task 4 — GET /v1/identity: read-only identity surface (teamId, projectId, masked key).
    // Runs under the same readAuth middleware as /v1/settings (memories:read).
    // The reveal query param is also gated on loopback inside registerIdentityRoutes.
    const identityReadAuth = requirePostgresServerAuth(this.options.pool, {
      authMode: this.options.authMode,
      allowLocalDevBypass: this.options.allowLocalDevBypass,
      localDevTeamId: this.options.localDevTeamId,
      localDevProjectId: this.options.localDevProjectId,
      // THE TRACKED-VIEW GRANT MUST BE HERE TOO. /v1/identity does not use
      // `readAuth` — it builds its own middleware — so wiring the grant into
      // baseRead alone left the one endpoint the dashboard needs still answering
      // 401 for a tracked project. That is exactly what the Join button reads,
      // so the feature was inert despite the grant being present and correct.
      resolveTrackedView: this.options.resolveTrackedView,
      requiredScopes: ['memories:read'],
    });
    app.use('/v1/identity', (req, res, next) => {
      if (req.method === 'GET') {
        identityReadAuth(req, res, next);
      } else {
        next();
      }
    });
    registerIdentityRoutes(app, {
      credentialStore: this.options.credentialStore ?? new CredentialStore(),
      requireScopes: (req: Request, res: Response, needed: string): boolean => {
        const scopes: string[] = (req as any).authContext?.scopes ?? [];
        if (scopes.includes('*') || scopes.includes(needed)) return true;
        res.status(403).json({ error: 'Forbidden', message: 'insufficient scope' });
        return false;
      },
      // Report THIS project's runtime, resolved from its own marker via the path
      // recorded in projects.metadata. Settings uses it to hide GO TEAM on a
      // project already in team mode. Fail-safe to 'local' — never guessed from
      // the server's cwd, which would report the server's runtime for every
      // project.
      resolveRuntime: async (projectId: string) => {
        try {
          const result = await this.options.pool.query(
            'SELECT metadata FROM projects WHERE id = $1',
            [projectId],
          );
          const row = result.rows[0] as { metadata?: Record<string, unknown> | null } | undefined;
          // NO ROW: a project this server has never recorded — e.g. a clone whose
          // first session has not run yet.
          //
          // My first attempt at this fell back to the marker at
          // `MEMSMITH_PROJECT_CWD ?? process.cwd()`. That is the SERVER's
          // directory, and one server serves every project, so it names some
          // unrelated project — the cross-project resolution settingsRoutes:96
          // already warns about ("never from the server's cwd"). It also failed
          // in practice: a marker-only project resolved 'local' and the Join
          // button stayed hidden, the very thing the fallback was added for.
          //
          // With no recorded path there is nothing legitimate to read, so say
          // 'local' and show no team affordance. A wrong "team" is worse than a
          // missing badge — it drives the Join and Go Team flows.
          if (!row) return 'local';
          return resolveProjectRuntime(
            { projectId, metadata: row.metadata ?? null },
            readProjectMarkerForRuntime,
          );
        } catch {
          return 'local';
        }
      },
    });

    // Item 3 (2026-07-27 local-fresh-install-readiness) — GET /v1/projects:
    // read-only project-switcher surface. Runs under the same readAuth as
    // /v1/identity so authContext.projectId is populated for isCurrent — but
    // the route's own handler independently re-checks the three-part loopback
    // gate (isLocalhost && hasLoopbackHostHeader && !hasForwardedClientHeaders),
    // the same gate already shipped for the viewer cookie, so a non-loopback
    // caller is refused even if auth alone would have let it through.
    app.use('/v1/projects', (req, res, next) => {
      if (req.method === 'GET') {
        identityReadAuth(req, res, next);
      } else {
        next();
      }
    });
    registerProjectsRoutes(app, {
      pool: this.options.pool,
      credentialStore: this.options.credentialStore ?? new CredentialStore(),
    });

    // Task 6 — /v1/members management routes.
    // GET  /v1/members         — readAuth + ≥member: list team members
    // POST /v1/members         — writeAuth + ≥admin: add/upsert a member (role)
    // PATCH /v1/members/:userId — writeAuth + ≥admin: change a member's role
    // DELETE /v1/members/:userId — writeAuth + ≥admin: remove member + revoke their keys
    //
    // Every query is scoped to req.authContext.teamId. Role gating is enforced
    // both by requireRole middleware (admits/rejects before the handler body)
    // and by an additional elevation check inside POST/PATCH (no-role-above-self).
    // DELETE also guards the last-owner invariant (403 if removing would leave
    // zero owners).

    // GET /v1/members — list all members of the caller's team. Requires ≥member.
    app.get('/v1/members', readAuth, requireRole('member'), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const teamsRepo = new PostgresTeamsRepository(this.options.pool);
      const members = await teamsRepo.listMembers(teamId);
      res.status(200).json({ members: members.map(m => ({
        userId: m.userId,
        role: m.role,
        createdAt: new Date(m.createdAtEpoch).toISOString(),
        updatedAt: new Date(m.updatedAtEpoch).toISOString(),
      })) });
    }));

    // POST /v1/members — add (upsert) an existing user with a role.
    // Requires ≥admin. Forbids assigning a role above the caller's own role.
    app.post('/v1/members', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const { userId, role } = req.body as { userId?: unknown; role?: unknown };
      if (typeof userId !== 'string' || !userId) {
        res.status(400).json({ error: 'ValidationError', message: 'userId is required' });
        return;
      }
      const validRoles = ['owner', 'admin', 'member', 'viewer'];
      if (typeof role !== 'string' || !validRoles.includes(role)) {
        res.status(400).json({ error: 'ValidationError', message: `role must be one of: ${validRoles.join(', ')}` });
        return;
      }
      // Forbid assigning a role above the caller's own role (no privilege escalation).
      const callerRole = req.authContext?.role ?? null;
      if (!roleSatisfies(callerRole, role as PostgresTeamRole)) {
        res.status(403).json({ error: 'Forbidden', message: 'cannot assign a role above your own' });
        return;
      }
      const teamsRepo = new PostgresTeamsRepository(this.options.pool);
      const member = await teamsRepo.addMember({ teamId, userId, role: role as PostgresTeamRole });
      res.status(200).json({ member: {
        userId: member.userId,
        role: member.role,
        createdAt: new Date(member.createdAtEpoch).toISOString(),
        updatedAt: new Date(member.updatedAtEpoch).toISOString(),
      } });
    }));

    // PATCH /v1/members/:userId — change role. Requires ≥admin.
    // Guard 1 (no-modify-above-self): forbid PATCH when the TARGET's CURRENT
    //   role is above the caller's own role → admin cannot touch an owner at all.
    // Guard 2 (new-role-not-above-self): forbid assigning a role above caller's own.
    // Guard 3 (last-owner on demotion): if target is currently owner and the
    //   change would leave zero owners, 403. Covers the owner-demoting-themselves
    //   case that guard 1 cannot block (owner's role == caller's role, not above).
    app.patch('/v1/members/:userId', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const targetUserId = String(req.params.userId);
      const { role } = req.body as { role?: unknown };
      const validRoles = ['owner', 'admin', 'member', 'viewer'];
      if (typeof role !== 'string' || !validRoles.includes(role)) {
        res.status(400).json({ error: 'ValidationError', message: `role must be one of: ${validRoles.join(', ')}` });
        return;
      }
      const callerRole = req.authContext?.role ?? null;
      // Guard 2: forbid elevating to a role above the caller's own role.
      if (!roleSatisfies(callerRole, role as PostgresTeamRole)) {
        res.status(403).json({ error: 'Forbidden', message: 'cannot assign a role above your own' });
        return;
      }
      const teamsRepo = new PostgresTeamsRepository(this.options.pool);
      // Verify the member exists in this team before updating.
      const existingRole = await teamsRepo.getMemberRole(teamId, targetUserId);
      if (!existingRole) {
        res.status(404).json({ error: 'NotFound', message: 'Member not found' });
        return;
      }
      // Guard 1: forbid modifying a member whose current role is above the caller's.
      // e.g. admin (rank 2) cannot modify owner (rank 3).
      if (!roleSatisfies(callerRole, existingRole)) {
        res.status(403).json({ error: 'Forbidden', message: 'cannot modify a member whose role is above your own' });
        return;
      }
      // Guard 3: last-owner guard on demotion. If the target is currently an owner
      // and the new role is not owner, ensure at least one other owner remains.
      if (existingRole === 'owner' && role !== 'owner') {
        const members = await teamsRepo.listMembers(teamId);
        const ownerCount = members.filter(m => m.role === 'owner').length;
        if (ownerCount <= 1) {
          res.status(403).json({ error: 'Forbidden', message: 'cannot demote the last owner' });
          return;
        }
      }
      const member = await teamsRepo.setMemberRole(teamId, targetUserId, role as PostgresTeamRole);
      res.status(200).json({ member: {
        userId: member.userId,
        role: member.role,
        createdAt: new Date(member.createdAtEpoch).toISOString(),
        updatedAt: new Date(member.updatedAtEpoch).toISOString(),
      } });
    }));

    // DELETE /v1/members/:userId — remove member and revoke their keys.
    // Requires ≥admin. Forbids removing the last owner (403).
    app.delete('/v1/members/:userId', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const targetUserId = String(req.params.userId);
      const teamsRepo = new PostgresTeamsRepository(this.options.pool);

      // Load all current members to enforce last-owner invariant.
      const members = await teamsRepo.listMembers(teamId);
      const target = members.find(m => m.userId === targetUserId);
      if (!target) {
        res.status(404).json({ error: 'NotFound', message: 'Member not found' });
        return;
      }
      // Guard: if the target is an owner and they are the only owner, refuse.
      if (target.role === 'owner') {
        const ownerCount = members.filter(m => m.role === 'owner').length;
        if (ownerCount <= 1) {
          res.status(403).json({ error: 'Forbidden', message: 'cannot remove the last owner' });
          return;
        }
      }

      // Revoke the removed user's api_keys scoped to this team.
      await this.options.pool.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE team_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [teamId, targetUserId],
      );

      await teamsRepo.removeMember(teamId, targetUserId);
      res.status(200).json({ removed: true, userId: targetUserId });
    }));

    // Task 5 — Go Team Wizard: /v1/convert/test-connection + /v1/convert/migrate.
    // Both routes are owner-gated (writeAuth + requireRole('owner')).
    // probe: stateless connection check (no local DB writes).
    // convert: the client posts only { databaseUrl }. The project to copy comes
    //   from req.authContext (see ConvertRoutes) — never from the server's cwd,
    //   which is how a request to convert one project previously copied another's
    //   entire memory to the remote.
    //
    // The server does DATABASE work only: bootstrap the remote schema, copy this
    // project's rows, verify counts. It does NOT write the project's marker or
    // its credential-store entry — those live in the user's project directory and
    // home directory, and belong to the process that runs THERE. The server
    // returns `join` (teamId/projectId/serverUrl/apiKey) and the project's own
    // session hook applies it.
    const credStore = new CredentialStore();
    registerConvertRoutes(app, {
      authMiddleware: [...writeAuth, requireRole('owner')],
      // Joining is what a NON-owner does, so it must not require owner —
      // otherwise only the person who already has the workspace could join it.
      // Possession of the team key is the authorization, verified against the
      // remote's api_keys by runJoin.
      //
      // READ auth, not write. writeAuth requires memories:write, which a TRACKED
      // project (a clone this machine holds no key for) by definition does not
      // have — so the one operation that exists to LEAVE the tracked state was
      // refused with "read-only until you join". Joining to get write access
      // required already having write access.
      //
      // Downgrading is safe because this route's real credential is the team key
      // in the request body, verified against the REMOTE by runJoin, exactly as
      // the note above says. Local scope was never the authorization here; it
      // only ever established which project is being joined
      // (req.authContext.projectId), which readAuth provides just as well.
      joinAuthMiddleware: readAuth,
      join: async (input) => {
        const { runJoin } = await import('../../convert/join-service.js');
        const result = await runJoin({
          connect: async (databaseUrl) => {
            const cfg = parsePostgresConfig({
              env: { MEMSMITH_SERVER_DATABASE_URL: databaseUrl } as NodeJS.ProcessEnv,
            });
            if (!cfg) throw new Error('invalid database URL');
            return createPostgresPool(cfg) as never;
          },
          // Same hash the api_keys table stores, so the lookup can match.
          hashKey: (raw) => createHash('sha256').update(raw).digest('hex'),
          deriveServerUrl,
          bootstrapSchema: (p) => bootstrapServerPostgresSchema(p as never),
          upsertProject: (p, teamId, projectId, name) =>
            upsertTeamAndProject(p as never, teamId, projectId, name),
          // Prefer HTTPS: with it the joiner needs only the team key and never a
          // database password. isHttpUrl inside runJoin decides per invite, so a
          // postgres:// invite still takes the retained fallback.
          transport: makeHttpsJoinTransport(),
        }, input);

        // Apply locally on success, exactly as convert does: cache the team's
        // key and flip this project's marker. applyConvertJoin independently
        // refuses if the marker at that path belongs to a different project, and
        // writes the key BEFORE the marker so the project is never in team mode
        // without a resolvable credential.
        if (result.status === 'joined' && result.join) {
          // Re-point this project's LOCAL api_keys row at the joined team.
          //
          // A join changes which team the project belongs to, and that has to
          // land in FOUR places: the marker, the CredentialStore, the remote's
          // projects table, and this row. It was landing in three. postgres-auth
          // builds authContext.teamId straight from api_keys, and every scoped
          // read filters on it — so the joiner authenticated as its OLD self
          // against its OLD team: /v1/identity reported runtime "team" with the
          // stale teamId and /v1/search returned zero observations while the
          // remote held the team's memory. Never throws; the remote side is
          // already committed by here.
          await repointLocalKeyToTeam(this.options.pool, result.join.teamId, input.projectId);
          // The project's OWN database carries its own teams/projects FK anchors
          // (seedHinge writes them at provision time), and the data tables FK to
          // projects(id, team_id) locally. Leaving those on the old team makes
          // the joined project unable to WRITE: the first observation insert
          // fails with observations_project_id_team_id_fkey. Reads worked, which
          // is why this survived the first round of join testing.
          try {
            const projectPool = await this.resolveLocalPoolForConvert({
              projectId: input.projectId, teamId: result.join.teamId,
            });
            if (projectPool !== this.options.pool) {
              await repointProjectDatabaseTeam(projectPool, result.join.teamId, input.projectId);
            }
          } catch { /* logged inside; a local anchor failure must not fail the join */ }
          try {
            const pathRow = await this.options.pool.query(
              'SELECT metadata FROM projects WHERE id = $1', [input.projectId],
            );
            const meta = (pathRow.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
            const projectPath = meta?.[PROJECT_PATH_KEY];
            // CAPTURE the outcome. applyConvertJoin returns { applied, reason }
            // rather than throwing, and this call discarded it while the convert
            // path below captures it — so all four local failure modes (no
            // marker, marker names another project, no apiKey/serverUrl, and the
            // no-recorded-path skip handled by the null below) answered a clean
            // 200 {"status":"joined"}.
            //
            // That silence is worse than a visible failure: repointLocalKeyToTeam
            // never throws, so the local api_keys row has ALREADY moved to the new
            // team and authContext.teamId follows it, while runtime-selector
            // resolves the credential by the MARKER's teamId. Without the flip the
            // key is cached under one team and looked up by another — team mode
            // with no resolvable credential, silently dropping every observation
            // while the user was told the join succeeded.
            const localApply = (typeof projectPath === 'string' && projectPath.trim())
              ? applyConvertJoin(
                {
                  readProjectMarker: readProjectMarkerForRuntime,
                  writeProjectRuntime,
                  storeKeyForTeam: (teamId, key) => credStore.storeKeyForTeam(teamId, key),
                  shareMarkerInGit,
                },
                projectPath,
                result.join,
              )
              // null, not a synthesised failure: applyConvertJoin never ran, which
              // summariseLocalApply reports with its own distinct reason.
              : null;
            if (localApply === null || !localApply.applied) {
              logger.warn('IDENTITY', 'join succeeded remotely but did not apply locally', {
                projectId: input.projectId,
                teamId: result.join.teamId,
                reason: localApply?.reason ?? 'no recorded project path',
              });
            }
            Object.assign(result, summariseLocalApply(localApply));
          } catch (error) {
            // The join itself succeeded remotely; a local apply failure is
            // recoverable on the next session rather than a reason to report
            // the whole join as failed. Still say so, for the same reason as
            // above — an unreported local failure is indistinguishable from
            // success to the caller.
            logger.warn('IDENTITY', 'join local apply threw', { projectId: input.projectId },
              error instanceof Error ? error : new Error(String(error)));
            Object.assign(result, summariseLocalApply({
              applied: false,
              reason: 'the local apply failed on this machine — start a session in the project to finish joining',
            }));
          }
        }
        return result;
      },
      probe: (url) => probeConnection(url, makeRealProbeDeps()),
      // HTTPS destinations are probed by asking the team server about itself, because
      // the owner never opens a connection to the destination database on that path.
      // /v1/info answers reachability and schema readiness; /v1/identity answers whether
      // this key authenticates. pgvector and version fitness are the remote's own
      // guarantees, reported rather than tested from here.
      probeHttps: async (serverUrl: string, teamKey: string) => {
        const base = serverUrl.replace(/\/+$/, '');
        try {
          const info = await fetch(`${base}/v1/info`);
          if (!info.ok) {
            return {
              connectivity: { reachable: false, authenticates: false },
              fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false },
              allGreen: false, fixable: [],
              error: `that server answered HTTP ${info.status}`,
            };
          }
          const body = await info.json() as {
            postgres?: { initialized?: boolean; reachable?: boolean };
          };
          // An authenticated call is the only way to know the KEY works: /v1/info is
          // deliberately unauthenticated, so a 200 there proves nothing about the key.
          //
          // /v1/connect is the right probe because it needs only a TEAM, not a project.
          // A team-wide key (project_id IS NULL) — which is exactly what an owner
          // converting a project holds — gets 404/400 from /v1/identity and /v1/usage
          // because those resolve a project first. Measured against the live server:
          //   valid key -> 400 (reached the handler, no project named)
          //   bogus key -> 403 (rejected by auth)
          // So 403 is the only status that means "this key is not valid"; anything else
          // means the credential passed the auth layer.
          const probe = await fetch(`${base}/v1/connect`, {
            headers: { authorization: `Bearer ${teamKey}` },
          });
          const authenticates = probe.status !== 403 && probe.status !== 401;
          const schemaReady = body.postgres?.initialized === true;
          const reachable = body.postgres?.reachable !== false;
          return {
            connectivity: { reachable, authenticates },
            fitness: { writable: authenticates, pgvector: schemaReady, versionOk: true, schemaReady },
            allGreen: reachable && authenticates && schemaReady,
            fixable: [],
            ...(authenticates ? {} : { error: 'that key is not valid for this server' }),
          };
        } catch {
          // Never echo the thrown message: it can contain the request, and the request
          // carries the team key.
          return {
            connectivity: { reachable: false, authenticates: false },
            fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false },
            allGreen: false, fixable: [],
            error: `cannot reach that server at ${base}`,
          };
        }
      },
      // Reuses the probe's connection deps: the same credentials that diagnosed
      // the gap are the ones that must be able to close it.
      applyFix: (url, fix) => fix === 'pgvector'
        ? applyPgvectorFix(url, makeRealProbeDeps())
        : Promise.resolve({ ok: false, error: `unknown fix: ${fix}` }),
      convert: async (input) => {
        // HTTPS DESTINATION: no pool to the remote at all.
        //
        // A managed database is unreachable from this machine — a direct probe of a real
        // private RDS times out even on VPN — so the copy goes over the same
        // authenticated HTTPS API every other MemSmith operation uses. Reads and local
        // counts still run against the LOCAL pool; only writes and remote counts cross
        // the network. runCopy's control flow is unchanged, which is the point of the
        // CopyDeps seam.
        if (input.transport?.kind === 'https') {
          const { makeHttpsCopyDeps } = await import('../../convert/copy-transport-https.js');
          const localPool = await this.resolveLocalPoolForConvert({
            projectId: input.projectId,
            teamId: input.teamId,
          });
          const scope = { projectId: input.projectId, teamId: input.teamId };
          const httpsDeps = makeHttpsCopyDeps({
            serverUrl: input.transport.serverUrl,
            teamKey: input.transport.teamKey,
            projectId: input.projectId,
            readLocalRows: async (table: string) => {
              // Same scoped read the direct path uses, so the project-scoping property
              // already proven for that path carries over unchanged.
              const { text } = buildScopedReadQuery(table, scope.projectId);
              const result = await localPool.query(text, [scope.projectId]);
              return restampTeamId(table, result.rows as Array<Record<string, unknown>>, scope.teamId);
            },
            countLocalRows: async (table: string) => {
              const q = buildScopedCountQuery(table, 'local');
              const r = await localPool.query(q.text, q.params(scope));
              return Number((r.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
            },
          });
          // THE PROJECT KEEPS ITS OWN KEY. A project's key is minted when the project is
          // created and never changes — a convert changes WHERE the project points, not
          // WHO it is. The direct path preserves this via ensureBaseKey, whose comment
          // calls the alternative out by name: "minting a second key would be the actual
          // bug — it orphans a credential whose plaintext is gone".
          //
          // This previously passed input.transport.teamKey — the DESTINATION key pasted
          // into the wizard — as the project's identity. applyConvertJoin then cached it
          // under the team, overwriting the project's own key, and the local server
          // cannot verify a key minted on the remote: the dashboard returned
          // "Invalid API key or insufficient scope" on a convert that had succeeded.
          //
          // The destination key remains the AUTHORIZATION for the copy; it is simply not
          // the project's identity.
          const projectKey = credStore.resolveKeyForTeam(input.teamId);
          if (!projectKey) {
            // Flipping without a resolvable key strands the project in server mode with
            // no credential — every hook then fails missing_api_key and silently drops
            // observations. Refuse instead.
            throw new Error('this project has no cached key — refusing to convert without one');
          }
          // Teach the remote this key's HASH so the project authenticates there too.
          // Only the hash crosses the wire; the remote stores hashes.
          const { registerProjectKeyHash } = await import('../../convert/register-project-key.js');
          const registered = await registerProjectKeyHash({
            serverUrl: input.transport.serverUrl,
            teamKey: input.transport.teamKey,
            projectId: input.projectId,
            projectKeyHash: hashApiKey(projectKey),
            // Lets register-key recover from "requires role owner" by
            // bootstrapping ownership once. Without it a user whose team key has
            // no team_members row on the remote simply cannot convert, and the
            // bootstrap route is reachable only by someone reading the source.
            //
            // Empty string, deliberately: the client does NOT know the
            // destination team's id — it holds that team's KEY, while the only
            // id it has is its own LOCAL team. So it calls the self-scoped route
            // and lets the remote infer the team from the key it presented.
            teamId: '',
          });
          if (!registered.ok) {
            throw new Error(`could not register this project's key on the team server: ${registered.reason}`);
          }

          const { runConvert } = await import('../../convert/convert-service.js');
          // serverUrl is KNOWN here rather than derived: the user supplied it, which is
          // what makes deriveServerUrl irrelevant on this path. databaseUrl is empty
          // because there is no database connection to describe.
          const httpsResult = await runConvert(
            { copyDeps: httpsDeps },
            {
              databaseUrl: '',
              ownerUserId: input.ownerUserId,
              teamId: input.teamId,
              projectId: input.projectId,
              serverUrl: input.transport.serverUrl,
              apiKey: projectKey,
            },
          );

          // APPLY THE FLIP LOCALLY, exactly as the join path does.
          //
          // runConvert deliberately does NOT write the marker — it hands back a `join`
          // object, because on a real remote team server the server's cwd is a directory
          // on someone else's machine (see convert-service.ts's note). But the caller
          // must then USE it, and this branch previously returned the result and dropped
          // it: the wizard reported "team", while the marker on disk still had no
          // runtime and no serverUrl, so the project stayed local. The dashboard was
          // right and the wizard was wrong.
          //
          // The project's own directory comes from its recorded metadata, never from the
          // server's cwd — guessing the cwd is the convert-scope bug one step later.
          if (httpsResult.status === 'converted' && httpsResult.join) {
            // RE-POINT THE LOCAL api_keys ROW, exactly as the join path does
            // (repoint-local-key.ts documents the "four places, three landed" bug this
            // closes). A convert changes which team+server this project belongs to, and
            // postgres-auth builds authContext straight from the local api_keys row.
            //
            // Without this the dashboard breaks the moment the convert succeeds: the
            // flip caches the REMOTE key under the same teamId, overwriting the local
            // one — CredentialStore is keyed by team alone — and resolveKeyForProject
            // then matches cached keys against the LOCAL api_keys table, finds no row
            // for the remote key, and hands the browser a credential this server cannot
            // verify. Reported live as "Not Authenticated" on a convert that had
            // otherwise fully succeeded.
            try {
              await repointLocalKeyToTeam(this.options.pool, httpsResult.join.teamId, input.projectId);
            } catch (error) {
              logger.warn('IDENTITY', 'convert could not repoint the local key', { projectId: input.projectId },
                error instanceof Error ? error : new Error(String(error)));
            }
            try {
              const pathRow = await this.options.pool.query(
                'SELECT metadata FROM projects WHERE id = $1', [input.projectId],
              );
              const meta = (pathRow.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
              const projectPath = meta?.[PROJECT_PATH_KEY];
              if (typeof projectPath === 'string' && projectPath.trim()) {
                const localApply = applyConvertJoin(
                  {
                    readProjectMarker: readProjectMarkerForRuntime,
                    writeProjectRuntime,
                    storeKeyForTeam: (teamId, key) => credStore.storeKeyForTeam(teamId, key),
                  shareMarkerInGit,
                  },
                  projectPath,
                  httpsResult.join,
                );
                if (!localApply.applied) {
                  logger.warn('IDENTITY', 'convert copied but did not flip locally', {
                    projectId: input.projectId, reason: localApply.reason,
                  });
                }
              } else {
                // Reported, not silent: the copy succeeded and the remote is populated,
                // but this project has no recorded path so nothing can flip it here. The
                // session hook in that project applies the join on its next run.
                logger.warn('IDENTITY', 'convert copied but no project path is recorded — flip deferred', {
                  projectId: input.projectId,
                });
              }
            } catch (error) {
              // Never fail a successful copy on a bookkeeping error: the data is already
              // on the remote and the retry is safe.
              logger.warn('IDENTITY', 'convert local flip failed', { projectId: input.projectId },
                error instanceof Error ? error : new Error(String(error)));
            }
          }
          return httpsResult;
        }

        const { deps, dispose } = await this.buildConvertCopyDeps(input.databaseUrl, {
          projectId: input.projectId,
          teamId: input.teamId,
        });
        try {
          // Prepare the destination, THEN resolve the key.
          //
          // These two used to share a branch: bootstrap + team/project upsert
          // lived inside the else-arm of `existingKey ?? ...`, so schema creation
          // silently depended on whether this machine happened to hold a cached
          // credential for the destination team — two entirely unrelated concerns.
          //
          // With a key cached, the whole block was skipped and the copy ran
          // against a database with zero tables. It worked exactly once: a
          // first-ever convert from a machine that had never held the team key,
          // which is the demo path. A RETRY fails (the first attempt cached the
          // key), and so does any machine that already joined this team. Measured
          // on the live rig: key cached, destination at 0 tables.
          //
          // bootstrapServerPostgresSchema is idempotent by design (every step is
          // IF NOT EXISTS, version markers are ON CONFLICT DO NOTHING), and
          // upsertTeamAndProject is likewise — so running both unconditionally is
          // free, and it is what the route comment above already promised.
          const cfg = parsePostgresConfig({
            env: { MEMSMITH_SERVER_DATABASE_URL: input.databaseUrl } as NodeJS.ProcessEnv,
          });
          if (!cfg) throw new Error('invalid databaseUrl for convert');
          const remotePool = createPostgresPool(cfg);
          let apiKey: string;
          try {
            await bootstrapServerPostgresSchema(remotePool);
            // `projects` is the first COPY_TABLES entry and every other copied
            // table FKs to it, so the destination needs the team+project rows
            // before the copy regardless of how the key was obtained.
            await upsertTeamAndProject(remotePool, input.teamId, input.projectId);
            // Unconditional, for the same reason bootstrap above is: a cached
            // credential says nothing about whether the REMOTE can validate it.
            //
            // This previously read `credStore.resolveKeyForTeam(teamId) ?? await
            // ensureBaseKey(...)`. A local install ALWAYS has a cached key for
            // its own team (local mode mints one at first boot), so the left side
            // always won and ensureBaseKey — the only writer of the remote's
            // api_keys — never ran against the destination. The owner never
            // noticed, because the owner authenticates against their LOCAL base
            // database where the hash does exist. But runJoin validates a
            // teammate's key on the REMOTE, so with zero api_keys rows there
            // every genuine invite was rejected as "not valid for this
            // workspace": the join accept path could not succeed for anyone.
            // Measured on the rig after two converts: projects 2, team_members 1,
            // api_keys 0.
            //
            // Calling ensureBaseKey unconditionally does NOT rotate the key. Its
            // cache/DB-drift branch returns the cached plaintext unchanged and
            // only re-inserts the missing hash, so this reuses the invited key
            // and is idempotent across retries and re-converts. Minting a second
            // key would be the actual bug — it orphans a credential whose
            // plaintext is gone, which can be neither used nor revoked.
            apiKey = await ensureBaseKey(remotePool, input.teamId, input.projectId, credStore);
          } finally {
            await remotePool.end();
          }

          // Prefer an EXPLICIT server URL over deriving one from the database.
          //
          // deriveServerUrl keeps the DATABASE hostname and drops the port for a
          // non-localhost host, so on AWS — API behind an ALB, database on RDS —
          // it produces https://<rds-host>, where nothing serves /v1. The convert
          // would stamp a marker that breaks every later request from this
          // project, and the only remedy was hand-editing project.json.
          //
          // deriveServerUrl always had an override branch, but nothing reached it:
          // its only consumer (makeResolveConvertContext) has no call sites and
          // this line passed a single argument. resolveConvertServerUrl supplies
          // the override, preferring the project's own marker, then
          // MEMSMITH_SERVER_URL, then the unchanged derivation — so no existing
          // install changes behaviour.
          const markerServerUrl = await this.readMarkerServerUrl(input.projectId);
          const serverUrl = resolveConvertServerUrl({
            databaseUrl: input.databaseUrl,
            markerServerUrl,
            // NOTE this setting has a LOCALHOST default, so it cannot simply be
            // trusted; resolveConvertServerUrl discards a loopback value when the
            // database is remote.
            settingServerUrl: process.env.MEMSMITH_SERVER_URL,
          });
          if (serverUrl !== deriveServerUrl(input.databaseUrl)) {
            logger.info('IDENTITY', 'using an explicit server URL instead of deriving from the database', {
              projectId: input.projectId, serverUrl,
            });
          }
          const result = await runConvert({ copyDeps: deps }, { ...input, serverUrl, apiKey });

          // Leave the note for the project's own session hook to claim.
          //
          // On the LOCAL base-account database (this.options.pool), NOT the
          // destination: the hook has to be able to find the note using only what
          // it already has, and putting it on the remote is circular — reaching the
          // remote requires the URL the note itself carries. The hook opens this
          // same base pool at session start for identity minting.
          //
          // This is a row addressed by projectId, which comes from the api_keys row
          // and cannot be steered by the caller — not a filesystem path the server
          // had to guess. That distinction is the whole point: guessing paths is
          // what let a convert of one project flip another's marker.
          //
          // Success only: a failed verify must never leave a project primed to
          // switch to an incomplete remote. Carries no key — the hook resolves that
          // from CredentialStore, where the mint above cached it.
          if (result.status === 'converted') {
            await recordPendingJoin(this.options.pool, {
              projectId: input.projectId,
              teamId: input.teamId,
              serverUrl,
            });

            // Complete the flip NOW rather than waiting for the project's next
            // session. The marker is re-read on every call (verified live:
            // flipping server->local->server inside one process was followed
            // every time), so there is no reason to make the user start a session
            // to see a switch that takes effect immediately.
            //
            // The path comes from the AUTHENTICATED project's own record — never
            // the server's cwd, which is what copied one project's memory into
            // another's remote. applyConvertJoin independently refuses if the
            // marker at that path belongs to a different project, so a stale or
            // reused directory cannot flip the wrong one.
            //
            // Best-effort: the pending note above stays until this succeeds, so a
            // failure here just means the project's next session finishes the job.
            try {
              const pathRow = await this.options.pool.query(
                'SELECT metadata FROM projects WHERE id = $1',
                [input.projectId],
              );
              const meta = (pathRow.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
              const projectPath = meta?.[PROJECT_PATH_KEY];
              if (typeof projectPath === 'string' && projectPath.trim()) {
                const applied = applyConvertJoin(
                  {
                    readProjectMarker: readProjectMarkerForRuntime,
                    writeProjectRuntime,
                    storeKeyForTeam: (teamId, key) => credStore.storeKeyForTeam(teamId, key),
                  shareMarkerInGit,
                  },
                  projectPath,
                  { teamId: input.teamId, projectId: input.projectId, serverUrl, apiKey },
                );
                if (applied.applied) {
                  await clearPendingJoin(this.options.pool, input.projectId);
                }
              }
            } catch {
              // Leave the note for the next session to claim.
            }
          }
          return result;
        } finally {
          await dispose();
        }
      },
    });

    // The REMOTE half of convert-over-HTTPS: /v1/convert/import + /v1/convert/verify.
    //
    // OWNER-GATED, exactly like registerConvertRoutes above. Not requireWriteRole():
    // that treats role == null as member-equivalent (postgres-auth.ts), and this route
    // writes RAW ROWS into seven tables, so a roleless key must never reach it. The
    // route additionally refuses a team-scoped key (project_id IS NULL), because such a
    // key reaches every project in its team and so has not identified which one to
    // import into.
    registerConvertImportRoutes(app, {
      authMiddleware: [...writeAuth, requireRole('owner')],
      pool: this.options.pool as never,
    });

    // The REMOTE half of join-over-HTTPS. Unauthenticated by design (the team
    // key is a body parameter so the four rejection reasons stay distinct), so
    // the rate limiter is mandatory rather than optional here.
    registerJoinRegisterRoute(app, {
      rateLimit: [requireJoinRateLimit(
        this.options.pool,
        { windowSec: 900, max: 10 },
        (raw) => createHash('sha256').update(raw).digest('hex'),
      )],
      hashKey: (raw) => createHash('sha256').update(raw).digest('hex'),
      lookupKey: async (keyHash) => {
        const r = await this.options.pool.query(
          'SELECT team_id, revoked_at, expires_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
          [keyHash],
        );
        const row = r.rows[0] as { team_id: string | null; revoked_at: Date | null; expires_at: Date | null } | undefined;
        if (!row) return null;
        return { teamId: row.team_id, revokedAt: row.revoked_at, expiresAt: row.expires_at };
      },
      upsertProject: async (teamId, projectId, name) => {
        await upsertTeamAndProject(this.options.pool, teamId, projectId, name);
      },
    });
  }

  // Task 5 — resolve the DATA-table read pool for a given (projectId, teamId)
  // scope OUTSIDE an HTTP request (the Go Team convert closure has no `req`
  // to read req.databasePool from — resolveConvertContext/convert run from a
  // ConvertRoutesDeps callback, not a request handler). Mirrors
  // resolveRequestDatabase's routing rule exactly: base pool for the
  // baseProjectId, else the registry-resolved per-project pool. Falls back to
  // the base pool when no registry was constructed (matches every other
  // DATA-site fallback in this file).
  /**
   * Run a read against EVERY project in the caller's team and merge the results.
   *
   * Team mode's whole point is that a teammate can see the team's memory, but
   * reads route to one msp_<projectId> database, so a joined project queried its
   * own — empty — database. Measured live: a successful join followed by
   * POST /v1/search returning [].
   *
   * SECURITY: the team comes from authContext (the caller passes `teamId`, which
   * every route already sources from requireTeamId), and the project list is
   * derived by asking the ACCOUNT database which projects belong to that team.
   * No client-supplied value reaches the database choice, so
   * resolveRequestDatabase's invariant is preserved — the widening is "one
   * project in my team" -> "all projects in my team", never across teams.
   *
   * Falls back to the caller's own pool when there is no registry (single-pool
   * deployments) or when the account lookup finds nothing, so a failure here
   * degrades to today's behaviour rather than an error.
   */
  private async readTeamWide<T extends { createdAtEpoch?: number }>(
    scope: { projectId: string; teamId: string },
    ownPool: PostgresPool,
    limit: number,
    read: (pool: PostgresPool, projectId: string) => Promise<T[]>,
  ): Promise<T[]> {
    const registry = this.options.poolRegistry;
    if (!registry) return read(ownPool, scope.projectId);

    const targets = await listTeamProjects(this.options.pool, scope.teamId, {
      baseProjectId: this.options.baseProjectId ?? null,
      baseDatabaseName: this.options.baseDatabaseName ?? 'postgres',
    });
    // A team of one, or an account lookup that failed: nothing to fan out to.
    if (targets.length <= 1) return read(ownPool, scope.projectId);

    const rows = await readAcrossTeam(
      targets,
      async (databaseName, projectId) =>
        projectId === scope.projectId ? ownPool
          : databaseName === (this.options.baseDatabaseName ?? 'postgres') ? this.options.pool
          : registry.getPool(databaseName, { teamId: scope.teamId, projectId }),
      read,
    );
    // Each project applied `limit` itself, so re-sort before cutting: otherwise
    // the caller gets one project's newest rows followed by another's, which is
    // not a recency ordering.
    return mergeTeamResults(rows, limit);
  }

  /**
   * This project's marker `serverUrl`, if it has one.
   *
   * Used to override convert's URL derivation, which keeps the DATABASE hostname
   * and would point an AWS deployment at RDS instead of the ALB. The marker is
   * the best-evidenced source: it was written by a real previous convert or join.
   *
   * Reads the project's directory from projects.metadata the same way the join
   * path does (PROJECT_PATH_KEY), because the server does not otherwise know
   * where a project lives on disk. Never throws — a missing path, a missing
   * marker, or an unreadable one all mean "no override", and the caller falls
   * back to deriving. That path is stale-tolerant by design: applyConvertJoin
   * independently verifies the marker belongs to this project before writing it.
   */
  private async readMarkerServerUrl(projectId: string): Promise<string | undefined> {
    try {
      const row = await this.options.pool.query(
        'SELECT metadata FROM projects WHERE id = $1', [projectId],
      );
      const meta = (row.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
      const projectPath = meta?.[PROJECT_PATH_KEY];
      if (typeof projectPath !== 'string' || !projectPath.trim()) return undefined;
      const marker = readProjectMarkerForRuntime(projectPath);
      // Only trust a marker that names THIS project. A stale recorded path can
      // point at another project's directory, and adopting its serverUrl would
      // send this convert to the wrong server.
      if (!marker || marker.projectId !== projectId) return undefined;
      return marker.serverUrl?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveLocalPoolForConvert(scope: { projectId: string; teamId: string }): Promise<PostgresPool> {
    if (!this.options.poolRegistry) return this.options.pool;
    if (scope.projectId === this.options.baseProjectId) return this.options.pool;
    const databaseName = projectDatabaseName(scope.projectId);
    return this.options.poolRegistry.getPool(databaseName, scope);
  }

  // Build parameterized CopyDeps for the Go Team conversion:
  // - readRows/countRows('local') read from the caller's OWN project database
  //   (resolved via resolveLocalPoolForConvert), never a hardcoded base pool —
  //   COPY_TABLES includes per-project data tables (observations, agent_events,
  //   etc.), so this must follow the same per-request-database routing rule as
  //   every other DATA site in this file.
  // - upsertRows/countRows('remote') use a fresh pool for the remote URL.
  // Table names come from the COPY_TABLES constant (a fixed safe list — never user input).
  // The remote schema is bootstrapped before returning so INSERTs have all tables + pgvector.
  private async buildConvertCopyDeps(
    remoteUrl: string,
    scope: { projectId: string; teamId: string },
  ): Promise<{ deps: CopyDeps; dispose: () => Promise<void> }> {
    const remoteConfig = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: remoteUrl } as NodeJS.ProcessEnv });
    if (!remoteConfig) throw new Error('invalid remote databaseUrl');
    const remotePool = createPostgresPool(remoteConfig);

    // Resolved before ensureBootstrapped is defined because that closure reads
    // the local teams row; keeping the declaration above its use avoids relying
    // on call-time ordering to stay valid.
    const localPool = await this.resolveLocalPoolForConvert(scope);

    let bootstrapped = false;
    let generatedColumns: GeneratedColumnMap = new Map();
    const ensureBootstrapped = async (): Promise<void> => {
      if (bootstrapped) return;
      await bootstrapServerPostgresSchema(remotePool);
      // Five of the seven COPY_TABLES carry a team_id FK (projects,
      // server_sessions, agent_events, observation_generation_jobs,
      // observations), and `projects` is copied first — so on a remote that has
      // no such team yet, the convert died on
      // projects_team_id_fkey before a single row landed. The team row is a
      // hinge the data depends on, not account state to be copied: ensure it
      // exists, never modify it if it already does.
      //
      // Carry the local team's real name across so the remote does not display a
      // bare UUID. Best-effort: the name is cosmetic, and failing to read it must
      // not block the conversion (ensureRemoteTeamHinge falls back to the id).
      let teamName: string | undefined;
      try {
        const named = await localPool.query(
          'SELECT name FROM teams WHERE id = $1',
          [scope.teamId],
        );
        const candidate = (named.rows[0] as { name?: unknown } | undefined)?.name;
        if (typeof candidate === 'string' && candidate.trim()) teamName = candidate;
      } catch {
        // Local teams row unreadable — fall through to the id-as-name default.
      }
      await ensureRemoteTeamHinge(remotePool, { teamId: scope.teamId, teamName });
      // Generated columns (e.g. observations.content_search, a tsvector) come
      // back from SELECT * but Postgres rejects any INSERT that names them.
      // Discovered from the destination schema so a future migration adding one
      // cannot silently reintroduce the crash.
      generatedColumns = await discoverGeneratedColumns(remotePool);
      bootstrapped = true;
    };

    const deps: CopyDeps = {
      readRows: async (table: string) => {
        const { text } = buildScopedReadQuery(table, scope.projectId);
        const result = await localPool.query(text, [scope.projectId]);
        return restampTeamId(table, result.rows as Array<Record<string, unknown>>, scope.teamId);
      },
      upsertRows: async (table: string, rows: Array<Record<string, unknown>>) => {
        if (rows.length === 0) return;
        await ensureBootstrapped();
        // Must run after ensureBootstrapped — that is what populates the map.
        const writable = stripGeneratedColumns(table, rows, generatedColumns);
        const cols = Object.keys(writable[0]!);
        const colList = cols.map(c => `"${c}"`).join(', ');
        for (const row of writable) {
          const values = cols.map(c => row[c]);
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          await remotePool.query(
            `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
            values,
          );
        }
      },
      countRows: async (which: 'local' | 'remote', table: string) => {
        const pool = which === 'local' ? localPool : remotePool;
        // Verification can be the first thing to touch the remote when a project
        // has no rows to copy (upsertRows returns early on an empty batch, so it
        // never triggers the bootstrap). Counting against a database with no
        // tables would throw instead of reporting zero.
        if (which === 'remote') await ensureBootstrapped();
        const { text, params } = buildScopedCountQuery(table, which);
        const result = await pool.query(text, params(scope));
        return Number((result.rows[0] as { count: string }).count);
      },
    };

    return { deps, dispose: () => remotePool.end() };
  }

  // Phase 11 — resolve actor identity for audit. We look up the api_keys row
  // by id and read its actor_id column. This MUST NOT be used for auth — it
  // is purely a denormalization for audit trails. If the lookup fails for
  // any reason we return null and let the audit row carry a missing actor.
  private async resolveActorId(req: Request): Promise<string | null> {
    const apiKeyId = req.authContext?.apiKeyId ?? null;
    if (!apiKeyId) return null;
    try {
      const result = await this.options.pool.query<{ actor_id: string | null }>(
        'SELECT actor_id FROM api_keys WHERE id = $1',
        [apiKeyId],
      );
      return result.rows[0]?.actor_id ?? null;
    } catch (error) {
      logger.warn('SYSTEM', 'failed to resolve actor_id for audit', {
        apiKeyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private resolveQueue(lane: 'summary' | 'event'): ReturnType<ActiveServerQueueManager['getQueue']> | null {
    const override = lane === 'summary' ? this.options.getSummaryQueue : this.options.getEventQueue;
    if (override) {
      return override();
    }
    const manager = this.options.queueManager as Partial<ActiveServerQueueManager>;
    if (typeof manager.getQueue === 'function') {
      try {
        return manager.getQueue(lane);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('SYSTEM', 'queue lane resolution failed; enqueue will be skipped', { lane }, err);
        return null;
      }
    }
    return null;
  }

  private toAgentEventInput(body: z.infer<typeof CreateAgentEventSchema>, teamId: string): CreatePostgresAgentEventInput {
    const sourceAdapter = body.sourceType ?? SOURCE_ADAPTER_DEFAULT;
    const occurredAtEpoch = typeof body.occurredAtEpoch === 'number' ? body.occurredAtEpoch : Date.now();
    return {
      projectId: body.projectId,
      teamId,
      serverSessionId: body.serverSessionId ?? null,
      contentSessionId: body.contentSessionId ?? null,
      sourceAdapter,
      sourceEventId: typeof (body as Record<string, unknown>).sourceEventId === 'string'
        ? ((body as Record<string, unknown>).sourceEventId as string)
        : null,
      eventType: body.eventType,
      platformSource: normalizePlatformSourceOrNull(body.platformSource),
      payload: (body.payload ?? {}) as object,
      metadata: typeof (body as Record<string, unknown>).metadata === 'object'
        && (body as Record<string, unknown>).metadata !== null
        ? ((body as Record<string, unknown>).metadata as Record<string, unknown>)
        : {},
      occurredAt: new Date(occurredAtEpoch),
    };
  }

  private requireTeamId(req: Request, res: Response): string | null {
    const teamId = req.authContext?.teamId ?? null;
    if (!teamId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is not bound to a team' });
      return null;
    }
    return teamId;
  }

  private async applyContentSessionLinks(
    inputs: CreatePostgresAgentEventInput[],
    rawBodies: unknown[],
    teamId: string,
    pool: PostgresPool = this.options.pool,
  ): Promise<void> {
    const repo = new PostgresServerSessionsRepository(pool);
    const lookups = new Map<string, Promise<string | null>>();

    await Promise.all(inputs.map(async (input, index) => {
      if (input.serverSessionId || !input.contentSessionId) return;

      const platformScope = this.sessionLookupPlatformScope(rawBodies[index]);
      const hasPlatformScope = Object.prototype.hasOwnProperty.call(platformScope, 'platformSource');
      const cacheKey = JSON.stringify([
        input.projectId,
        teamId,
        input.contentSessionId,
        hasPlatformScope,
        hasPlatformScope ? platformScope.platformSource ?? null : null,
      ]);
      let lookup = lookups.get(cacheKey);
      if (!lookup) {
        lookup = repo.findIdByContentSessionId({
          contentSessionId: input.contentSessionId,
          projectId: input.projectId,
          teamId,
          ...platformScope,
        }).catch((err: unknown) => {
          logger.warn('HTTP', 'session linkage lookup failed; storing event unlinked', {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        lookups.set(cacheKey, lookup);
      }

      const linkedId = await lookup;
      if (linkedId) input.serverSessionId = linkedId;
    }));
  }

  private sessionLookupPlatformScope(body: unknown): { platformSource?: string | null } {
    if (!body || typeof body !== 'object') return {};
    if (!Object.prototype.hasOwnProperty.call(body, 'platformSource')) return {};

    const value = (body as { platformSource?: unknown }).platformSource;
    return {
      platformSource: typeof value === 'string'
        ? normalizePlatformSource(value)
        : null,
    };
  }

  private ensureProjectAllowed(req: Request, res: Response, projectId: string): boolean {
    if (req.authContext?.projectId && req.authContext.projectId !== projectId) {
      res.status(403).json({ error: 'Forbidden', message: 'API key is scoped to a different project' });
      return false;
    }
    return true;
  }

  // Shared scoped-id lookup for the /:id routes. Resolves the row's project
  // via a team-scoped probe (404 cross-tenant to avoid revealing existence),
  // enforces the api key's project scope, then loads the full row. Routes
  // that must not disclose sibling-project existence pass
  // scopeMismatch: 'not-found' to answer 404 instead of 403.
  // Single source of ranking truth for the read endpoints (/v1/search,
  // /v1/context). Hybrid (FTS + vector via RRF, Sprint 2) is the DEFAULT — it
  // ranks materially better on the LongMemEval-S benchmark (R@5 ~0.936), most
  // notably on semantic queries with no lexical overlap that FTS cannot match.
  // Escape hatch: set MEMSMITH_SEARCH_HYBRID=0 to force plain FTS (repo.search)
  // without a redeploy — useful if the embedder is unavailable in a given
  // deployment (hybrid's vector arm depends on the onnxruntime-backed embedder
  // and on observations having embedding_vec populated). Same inputs, same
  // response shape either way; hybrid degrades to FTS results when the vector
  // arm is empty, so there is no hard dependency for correctness, only ranking.
  private async searchHybridEnabledFor(teamId: string): Promise<boolean> {
    if (this.options.settingsResolver) return this.options.settingsResolver.searchHybridEnabled(teamId);
    return process.env.MEMSMITH_SEARCH_HYBRID !== '0';
  }

  private async resolveSearchResults(
    input: {
      projectId: string;
      teamId: string;
      query: string;
      limit: number;
      platformSource: string | null;
      mode: 'search' | 'context';
      userDirected?: boolean;
    },
    pool: PostgresPool = this.options.pool,
  ): Promise<PostgresObservation[]> {
    const repo = new PostgresObservationRepository(pool);
    const hybrid = await this.searchHybridEnabledFor(input.teamId);
    let searchInput: typeof input & { ftsWeight?: number; vecWeight?: number; rrfK?: number } = input;
    if (this.options.settingsResolver) {
      const w = await this.options.settingsResolver.weights(input.teamId);
      const rrfK = await this.options.settingsResolver.rrfK(input.teamId);
      searchInput = { ...input, ftsWeight: w.fts, vecWeight: w.vec, rrfK };
    }
    const ranked = hybrid ? await repo.hybridSearch(searchInput) : await repo.search(searchInput);
    const boost = this.options.settingsResolver
      ? await this.options.settingsResolver.userNoteBoost(input.teamId)
      : process.env.MEMSMITH_USER_NOTE_BOOST !== '0' && process.env.MEMSMITH_USER_NOTE_BOOST?.toLowerCase() !== 'false' && process.env.MEMSMITH_USER_NOTE_BOOST?.toLowerCase() !== 'off';
    let boosted = ranked;
    try { boosted = boostUserDirected(ranked, boost); } catch { boosted = ranked; }  // fail-open
    try {
      return await this.applySupersession(boosted, input.mode, { teamId: input.teamId, projectId: input.projectId }, pool);
    } catch (err) {
      logger.warn('SYSTEM', 'supersession resolution failed; returning ranked results', {}, err instanceof Error ? err : new Error(String(err)));
      return boosted;
    }
  }

  private async applySupersession(
    ranked: PostgresObservation[],
    mode: 'search' | 'context',
    scope: { teamId: string; projectId?: string },
    pool: PostgresPool = this.options.pool,
  ): Promise<PostgresObservation[]> {
    if (ranked.length === 0) return ranked;
    const maxDepth = this.options.settingsResolver
      ? await this.options.settingsResolver.supersedeMaxDepth(scope.teamId)
      : undefined;
    const heads = await resolveHeads(pool, ranked.map(r => r.id), scope, maxDepth);
    const byId = new Map(ranked.map(r => [r.id, r]));
    const needHead = new Set<string>();
    for (const r of ranked) {
      const h = heads.get(r.id) ?? r.id;
      if (h !== r.id && !byId.has(h)) needHead.add(h);
    }
    const fetched = await this.fetchObservationsByIds([...needHead], scope, pool);
    for (const f of fetched) byId.set(f.id, f);

    if (mode === 'context') {
      const seen = new Set<string>();
      const out: PostgresObservation[] = [];
      for (const r of ranked) {
        const head = byId.get(heads.get(r.id) ?? r.id) ?? r;
        if (seen.has(head.id)) continue;
        seen.add(head.id);
        out.push(head);
      }
      return out;
    }
    // search: annotate + append missing heads right after their child
    const out: PostgresObservation[] = [];
    const emitted = new Set<string>();
    for (const r of ranked) {
      const headId = heads.get(r.id) ?? r.id;
      const item = headId !== r.id ? { ...r, supersededBy: headId } : r;
      if (!emitted.has(item.id)) { out.push(item); emitted.add(item.id); }
      if (headId !== r.id && !emitted.has(headId)) {
        const h = byId.get(headId);
        if (h) { out.push(h); emitted.add(headId); }
      }
    }
    return out;
  }

  private async fetchObservationsByIds(
    ids: string[],
    scope: { teamId: string; projectId?: string },
    pool: PostgresPool = this.options.pool,
  ): Promise<PostgresObservation[]> {
    if (ids.length === 0) return [];
    const args: unknown[] = [ids, scope.teamId];
    let projClause = '';
    if (scope.projectId) { projClause = ' AND project_id = $3'; args.push(scope.projectId); }
    const result = await pool.query<ObservationRow>(
      `SELECT * FROM observations WHERE id = ANY($1) AND team_id = $2${projClause}`,
      args,
    );
    return result.rows.map(mapObservationRow);
  }

  private async loadScopedById<T>(
    req: Request,
    res: Response,
    input: {
      id: string;
      teamId: string;
      table: 'agent_events' | 'server_sessions' | 'observation_generation_jobs';
      notFound: string;
      scopeMismatch?: 'not-found';
      load: (projectId: string) => Promise<T | null>;
    },
  ): Promise<T | null> {
    // All three tables here (agent_events, server_sessions,
    // observation_generation_jobs) are per-project DATA tables — always read
    // through the per-request pool when one was resolved.
    const probe = await (req.databasePool ?? this.options.pool).query(
      `SELECT project_id FROM ${input.table} WHERE id = $1 AND team_id = $2`,
      [input.id, input.teamId],
    );
    const row = probe.rows[0] as undefined | { project_id: string };
    if (!row) {
      res.status(404).json({ error: 'NotFound', message: input.notFound });
      return null;
    }
    if (input.scopeMismatch === 'not-found') {
      if (req.authContext?.projectId && req.authContext.projectId !== row.project_id) {
        res.status(404).json({ error: 'NotFound', message: input.notFound });
        return null;
      }
    } else if (!this.ensureProjectAllowed(req, res, row.project_id)) {
      return null;
    }
    const loaded = await input.load(row.project_id);
    if (!loaded) {
      res.status(404).json({ error: 'NotFound', message: input.notFound });
      return null;
    }
    return loaded;
  }

  // Single source of the scoped-observation predicate shared by the scoped delete
  // and its authorization read: a project-scoped key is confined to its project;
  // a team-scoped key spans the team. Positional WHERE + params so a SELECT and a
  // DELETE build on it identically.
  private observationScope(
    id: string, teamId: string, projectScope: string | null,
  ): { where: string; params: unknown[] } {
    return projectScope != null
      ? { where: 'id = $1 AND team_id = $2 AND project_id = $3', params: [id, teamId, projectScope] }
      : { where: 'id = $1 AND team_id = $2', params: [id, teamId] };
  }

  // Scoped row fetch for DELETE /v1/memories/:id authorization: returns the
  // row's kind + createdByUserId within the caller's scope, or null if absent.
  // Mirrors deleteObservationForScope's scoping exactly (project-scoped key
  // restricted to its project; team-scoped key to the team) so authorization
  // never sees a row the caller couldn't target.
  private async getObservationForDelete(
    id: string,
    teamId: string,
    projectScope: string | null,
    pool: PostgresPool = this.options.pool,
  ): Promise<{ kind: string; createdByUserId: string | null } | null> {
    const { where, params } = this.observationScope(id, teamId, projectScope);
    const result = await pool.query(
      `SELECT kind, metadata->>'createdByUserId' AS created_by_user_id FROM observations WHERE ${where}`,
      params,
    );
    const row = result.rows[0] as { kind: string; created_by_user_id: string | null } | undefined;
    if (!row) return null;
    return { kind: row.kind, createdByUserId: row.created_by_user_id };
  }

  // Scoped single-observation delete for DELETE /v1/memories/:id.
  // Project-scoped key deletes within its project; a team-scoped key
  // matches by id + team across the team's projects.
  private async deleteObservationForScope(
    id: string,
    teamId: string,
    projectScope: string | null,
    pool: PostgresPool = this.options.pool,
  ): Promise<boolean> {
    const deletion = new PostgresDataDeletionRepository(pool);
    if (projectScope) {
      // project branch scopes id + project + team inside the repository — aligned
      // with observationScope's project case by construction.
      return deletion.deleteObservation({ id, projectId: projectScope, teamId });
    }
    const { where, params } = this.observationScope(id, teamId, null);
    const byTeam = await pool.query(`DELETE FROM observations WHERE ${where}`, params);
    return (byTeam.rowCount ?? 0) > 0;
  }

  private handleDbError(error: unknown, res: Response, action: string): void {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('project_id must belong to team_id')
      || message.includes('server_session_id must belong')
      || message.includes('agent_event source_id must belong')
    ) {
      res.status(403).json({ error: 'Forbidden', message });
      return;
    }
    logger.error('SYSTEM', `${action} failed`, { error: message });
    res.status(500).json({ error: 'InternalError', message: 'Failed to persist event' });
  }

  private async auditWrite(
    req: Request,
    action: string,
    targetId: string | null,
    projectId: string | null,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const repo = new PostgresAuthRepository(this.options.pool);
    const actorId = await this.resolveActorId(req);
    // Phase 12 — every audit row carries request_id when one was minted
    // so dashboards and incident triage can pivot from a single HTTP
    // request to every ingest/job/audit row it produced. Caller-supplied
    // details win on key conflict so explicit overrides still work.
    const detailsWithRequestId: Record<string, unknown> = {
      ...(req.requestId ? { requestId: req.requestId } : {}),
      ...(details ?? {}),
    };
    const auditInput = {
      teamId: req.authContext?.teamId ?? null,
      projectId: projectId ?? req.authContext?.projectId ?? null,
      actorId,
      apiKeyId: req.authContext?.apiKeyId ?? null,
      action,
      resourceType: resolveAuditResourceType(action),
      resourceId: targetId,
      details: detailsWithRequestId,
    };
    try {
      await repo.createAuditLog(auditInput);
    } catch (error) {
      logger.warn('SYSTEM', 'audit log insert failed', {
        action,
        requestId: req.requestId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Phase 11 — paginated job listing for team/project queue endpoints.
  // Phase 12 — extended with `sourceType`, `since`, and (optional) payload
  // selection. Filtering is enforced in SQL (WHERE team_id [, project_id,
  // status, source_type, created_at]). Application-layer filtering is never
  // trusted alone for tenant scope.
  private async listJobsForScope(
    input: {
      teamId: string;
      projectId: string | null;
      status: string | null;
      sourceType?: string | null;
      limit: number;
      offset: number;
      since?: Date | null;
    },
    pool: PostgresPool = this.options.pool,
  ): Promise<{ jobs: JobListRow[]; total: number }> {
    const params: Array<string | number | Date> = [input.teamId];
    let where = 'WHERE team_id = $1';
    if (input.projectId) {
      params.push(input.projectId);
      where += ` AND project_id = $${params.length}`;
    }
    if (input.status) {
      params.push(input.status);
      where += ` AND status = $${params.length}`;
    }
    if (input.sourceType) {
      params.push(input.sourceType);
      where += ` AND source_type = $${params.length}`;
    }
    if (input.since) {
      params.push(input.since);
      where += ` AND created_at >= $${params.length}`;
    }
    const totalResult = await pool.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM observation_generation_jobs ${where}`,
      params,
    );
    const total = Number.parseInt(totalResult.rows[0]?.total ?? '0', 10);
    params.push(input.limit, input.offset);
    const limitParamIndex = params.length - 1;
    const offsetParamIndex = params.length;
    const result = await pool.query<JobListRow>(
      `
        SELECT id, project_id, team_id, source_type, source_id, status, attempts,
               max_attempts, created_at, completed_at, failed_at, last_error, payload
        FROM observation_generation_jobs
        ${where}
        ORDER BY created_at DESC
        LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      `,
      params,
    );
    return { jobs: result.rows, total };
  }

  // Phase 12 — operator retry. Status handling:
  //   - queued: no-op (idempotent; no double enqueue)
  //   - processing: 409 — running worker MUST finish or fail naturally
  //   - completed: 409 — observations index dedupes on (job_id, index,
  //     content) but LLM output is non-deterministic, so a second run
  //     would persist a parallel set of observations. Operator must
  //     create a new generation request instead of retrying.
  //   - failed/cancelled: reset to queued, clear locks, bump retried_count
  //     in payload metadata for audit, then re-enqueue. The deterministic
  //     BullMQ jobId means a duplicate transport publish collapses on the
  //     queue side too.
  private async retryGenerationJob(
    req: Request,
    res: Response,
    id: string,
    teamId: string,
  ): Promise<{ job: PostgresObservationGenerationJob; retriedCount: number; alreadyQueued: boolean } | null> {
    if (!id) {
      res.status(400).json({ error: 'ValidationError', message: 'job id required' });
      return null;
    }
    const pool = req.databasePool ?? this.options.pool;
    // Scope check first — same NotFound disclosure as the rest of the routes.
    const repo = new PostgresObservationGenerationJobRepository(pool);
    const current = await this.loadScopedById(req, res, {
      id,
      teamId,
      table: 'observation_generation_jobs',
      notFound: 'Generation job not found',
      scopeMismatch: 'not-found',
      load: (projectId) => repo.getByIdForScope({ id, projectId, teamId }),
    });
    if (!current) return null;

    // Idempotent fast-path: already queued -> emit audit only, no DB writes.
    if (current.status === 'queued') {
      await this.auditWrite(req, 'generation_job.retried_by_operator', current.id, current.projectId, {
        outcome: 'noop_already_queued',
        currentAttempts: current.attempts,
        requestId: req.requestId ?? null,
      });
      return { job: current, retriedCount: extractRetriedCount(current.payload), alreadyQueued: true };
    }

    if (current.status === 'processing') {
      // Refuse retry on in-flight jobs — the running worker MUST be allowed
      // to finish or fail through its normal lifecycle. Operator can wait
      // or cancel, then retry.
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job is currently processing; cancel or wait for completion before retrying',
      });
      return null;
    }

    if (current.status === 'completed') {
      // Refuse retry on already-completed jobs. The deduplication index on
      // observations (generation_key = job_id + index + content) does NOT
      // protect against re-running the provider, because LLM output is
      // non-deterministic and the second run almost always produces a
      // different content string. Replaying would persist a parallel set
      // of observations attributed to the same generation_job_id.
      // cancelGenerationJob applies the same 409 guard for the same reason.
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job already completed; retrying would duplicate observations',
      });
      return null;
    }

    // Reset to queued, clear lock + lifecycle timestamps, increment
    // retried_count for audit. attempts is intentionally preserved so the
    // BullMQ attempt cap is not bypassed; if the job hit max_attempts the
    // operator must lift the cap explicitly via a separate flow.
    //
    // current.payload is the canonical BullMQ payload persisted at outbox
    // create time (kind/team_id/project_id/source_type/source_id/
    // generation_job_id/api_key_id/actor_id/source_adapter/request_id).
    // The retry adds operator metadata to the persisted row but enqueues
    // ONLY the BullMQ payload — the worker calls
    // assertServerGenerationJobPayload(job.data) on receipt and would reject
    // the metadata-only object the previous implementation handed it.
    const retriedCount = extractRetriedCount(current.payload) + 1;
    const persistedBullmqPayload = (current.payload && typeof current.payload === 'object'
      ? current.payload
      : {}) as Record<string, unknown>;
    const newPayload = {
      ...persistedBullmqPayload,
      retried_count: retriedCount,
      last_retried_by_actor: req.authContext?.apiKeyId ?? null,
      last_retried_request_id: req.requestId ?? null,
    };
    // The payload we re-publish to BullMQ on retry: refresh request_id (so
    // the worker logs/audit attribute this run to the operator's request)
    // but keep all canonical job context that the worker validates against.
    const retryBullmqPayload = {
      ...persistedBullmqPayload,
      request_id: req.requestId ?? (persistedBullmqPayload as { request_id?: unknown }).request_id ?? null,
    };
    const updated = await pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'queued',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = NULL,
            cancelled_at = NULL,
            completed_at = NULL,
            last_error = NULL,
            attempts = LEAST(attempts, max_attempts - 1),
            payload = $4::jsonb,
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [id, current.projectId, teamId, JSON.stringify(newPayload)],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    // Append lifecycle event so the audit chain mirrors the lifecycle tracker.
    const eventsRepo = new PostgresObservationGenerationJobEventsRepository(pool);
    await eventsRepo.append({
      generationJobId: id,
      projectId: current.projectId,
      teamId,
      eventType: 'queued',
      statusAfter: 'queued',
      attempt: (updatedRow as { attempts: number }).attempts,
      details: {
        source: 'operator_retry',
        requestId: req.requestId ?? null,
        retriedCount,
      },
    });

    // Re-enqueue to BullMQ. If the queue is unavailable we leave the row in
    // queued state and reconciliation will publish it on next startup —
    // never lie about "enqueued" when we couldn't publish.
    const queue = this.resolveEventQueueForRetry(updatedRow as { source_type: string });
    if (queue && updatedRow) {
      try {
        const bullmqJobId = (updatedRow as { bullmq_job_id: string | null }).bullmq_job_id;
        if (bullmqJobId) {
          // Best effort remove first so a terminal-state slot doesn't block.
          try { await queue.remove(bullmqJobId); } catch { /* terminal slot may be missing — ok */ }
          await queue.add(bullmqJobId, retryBullmqPayload as never);
        }
      } catch (error) {
        logger.warn('SYSTEM', 'failed to re-enqueue generation job on operator retry', {
          jobId: id,
          requestId: req.requestId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const refreshed = await repo.getByIdForScope({ id, projectId: current.projectId, teamId });
    if (!refreshed) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    await this.auditWrite(req, 'generation_job.retried_by_operator', refreshed.id, refreshed.projectId, {
      previousStatus: current.status,
      currentStatus: refreshed.status,
      retriedCount,
      requestId: req.requestId ?? null,
    });

    return { job: refreshed, retriedCount, alreadyQueued: false };
  }

  // Phase 12 — operator cancel. Idempotent: a job already in `cancelled`
  // status is a no-op. Active processing rows are still cancelled but the
  // running worker is allowed to finish; Phase 11's lockOutbox guard
  // re-checks Postgres status before any side effect, so a cancelled job
  // will not produce observations even if the BullMQ delivery raced.
  private async cancelGenerationJob(
    req: Request,
    res: Response,
    id: string,
    teamId: string,
  ): Promise<{ job: PostgresObservationGenerationJob; alreadyCancelled: boolean } | null> {
    if (!id) {
      res.status(400).json({ error: 'ValidationError', message: 'job id required' });
      return null;
    }
    const pool = req.databasePool ?? this.options.pool;
    const repo = new PostgresObservationGenerationJobRepository(pool);
    const current = await this.loadScopedById(req, res, {
      id,
      teamId,
      table: 'observation_generation_jobs',
      notFound: 'Generation job not found',
      scopeMismatch: 'not-found',
      load: (projectId) => repo.getByIdForScope({ id, projectId, teamId }),
    });
    if (!current) return null;
    if (current.status === 'cancelled') {
      await this.auditWrite(req, 'generation_job.cancelled_by_operator', current.id, current.projectId, {
        outcome: 'noop_already_cancelled',
        requestId: req.requestId ?? null,
      });
      return { job: current, alreadyCancelled: true };
    }
    if (current.status === 'completed') {
      res.status(409).json({
        error: 'Conflict',
        message: 'Generation job already completed; cannot cancel',
      });
      return null;
    }

    const updateResult = await pool.query(
      `
        UPDATE observation_generation_jobs
        SET status = 'cancelled',
            cancelled_at = now(),
            updated_at = now()
        WHERE id = $1 AND project_id = $2 AND team_id = $3
        RETURNING *
      `,
      [id, current.projectId, teamId],
    );
    const updatedRow = updateResult.rows[0];
    if (!updatedRow) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    const eventsRepo = new PostgresObservationGenerationJobEventsRepository(pool);
    await eventsRepo.append({
      generationJobId: id,
      projectId: current.projectId,
      teamId,
      eventType: 'cancelled',
      statusAfter: 'cancelled',
      attempt: (updatedRow as { attempts: number }).attempts,
      details: {
        source: 'operator_cancel',
        requestId: req.requestId ?? null,
      },
    });

    // Best-effort BullMQ removal so a delayed/waiting job stops occupying
    // the slot. Active jobs cannot be removed; the lockOutbox status check
    // (Phase 11) is the authoritative side-effect guard.
    const queue = this.resolveEventQueueForRetry(updatedRow as { source_type: string });
    if (queue) {
      const bullmqJobId = (updatedRow as { bullmq_job_id: string | null }).bullmq_job_id;
      if (bullmqJobId) {
        try { await queue.remove(bullmqJobId); } catch {
          // Active jobs can't be removed; that's fine — Postgres status is canonical.
        }
      }
    }

    const refreshed = await repo.getByIdForScope({ id, projectId: current.projectId, teamId });
    if (!refreshed) {
      res.status(404).json({ error: 'NotFound', message: 'Generation job not found' });
      return null;
    }

    await this.auditWrite(req, 'generation_job.cancelled_by_operator', refreshed.id, refreshed.projectId, {
      previousStatus: current.status,
      currentStatus: refreshed.status,
      requestId: req.requestId ?? null,
    });

    return { job: refreshed, alreadyCancelled: false };
  }

  // Phase 12 — pick the right queue lane for a given source_type so retries
  // and cancels can publish to the same lane the original ingest used.
  private resolveEventQueueForRetry(row: { source_type: string }):
    { add: (jobId: string, payload: unknown, options?: unknown) => Promise<unknown>; remove: (jobId: string) => Promise<void> } | null {
    const lane = row.source_type === 'session_summary' ? 'summary' : 'event';
    const queue = this.resolveQueue(lane);
    if (!queue) return null;
    return queue as never;
  }

  private routeParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }
    return value ?? '';
  }

  private handleCreate<S extends ZodTypeAny, T = z.infer<S>>(
    schema: S,
    handler: (req: Request, res: Response, body: T) => Promise<void> | void,
  ) {
    return this.asyncHandler(async (req: Request, res: Response) => {
      const result = schema.safeParse(req.body);
      if (!result.success) {
        res.status(400).json({ error: 'ValidationError', issues: result.error.issues });
        return;
      }
      await handler(req, res, result.data as T);
    });
  }

  private asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
    return (req: Request, res: Response, next: (err?: unknown) => void): void => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }
}

interface JobListRow {
  id: string;
  project_id: string;
  team_id: string;
  source_type: string;
  source_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error: unknown;
  // Phase 12 — payload is OPTIONAL because the SELECT may omit it, and
  // serializers strip it unless the caller explicitly opted in.
  payload?: unknown;
}

const SOURCE_TYPE_VALUES = new Set(['agent_event', 'session_summary', 'observation_reindex']);

function parseGenericJobListingQuery(req: Request): {
  status: string | null;
  sourceType: string | null;
  limit: number;
  offset: number;
  since: Date | null;
} {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const status = statusRaw && JOB_LIST_STATUS_VALUES.has(statusRaw) ? statusRaw : null;
  const sourceTypeRaw = typeof req.query.source_type === 'string' ? req.query.source_type.trim() : '';
  const sourceType = sourceTypeRaw && SOURCE_TYPE_VALUES.has(sourceTypeRaw) ? sourceTypeRaw : null;
  const limit = clampInt(req.query.limit, JOB_LIST_DEFAULT_LIMIT, 1, JOB_LIST_MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const sinceRaw = typeof req.query.since === 'string' ? req.query.since.trim() : '';
  let since: Date | null = null;
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (!Number.isNaN(parsed.getTime())) since = parsed;
  }
  return { status, sourceType, limit, offset, since };
}

function extractRetriedCount(payload: Record<string, unknown> | null | undefined): number {
  if (!payload || typeof payload !== 'object') return 0;
  const value = (payload as { retried_count?: unknown }).retried_count;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

const JOB_LIST_STATUS_VALUES = new Set(['queued', 'processing', 'completed', 'failed', 'cancelled']);
const JOB_LIST_DEFAULT_LIMIT = 50;
const JOB_LIST_MAX_LIMIT = 200;

function parseJobListingQuery(req: Request): {
  status: string | null;
  limit: number;
  offset: number;
} {
  const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const status = statusRaw && JOB_LIST_STATUS_VALUES.has(statusRaw) ? statusRaw : null;
  const limit = clampInt(req.query.limit, JOB_LIST_DEFAULT_LIMIT, 1, JOB_LIST_MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { status, limit, offset };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serializeJobListEntry(
  row: JobListRow,
  options: { includePayload?: boolean } = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAtEpoch: new Date(row.created_at).getTime(),
    completedAtEpoch: row.completed_at ? new Date(row.completed_at).getTime() : null,
    failedAtEpoch: row.failed_at ? new Date(row.failed_at).getTime() : null,
    lastError: row.last_error && typeof row.last_error === 'object' ? row.last_error : null,
  };
  // Phase 12 — payload is sensitive (it may carry full event payloads
  // under `agent_events.payload`). Strip by default; only include when the
  // caller explicitly opted in via `?include=payload`. The route handler
  // gates that flag on admin scope BEFORE reaching here.
  if (options.includePayload && row.payload && typeof row.payload === 'object') {
    base.payload = row.payload;
  }
  return base;
}

// Phase 11 — every audit `action` carries a stable resource_type so dashboards
// can group/filter consistently. We map the dotted action name to a canonical
// resource_type keyword. Unknown actions fall back to the prefix (matches the
// previous behavior for backward compatibility).
function resolveAuditResourceType(action: string): string {
  const map: Record<string, string> = {
    'event.received': 'agent_event',
    'event.batch_received': 'agent_event',
    'event.write': 'agent_event',
    'event.batch_write': 'agent_event',
    'session.write': 'server_session',
    'session.end': 'server_session',
    'memory.write': 'observation',
    'observation.read': 'observation',
    'observation.search': 'observation',
    'observation.context': 'observation',
    'observation.generated': 'observation',
    'session_summary.generated': 'observation',
    'generation_job.queued': 'observation_generation_job',
    'generation_job.enqueued': 'observation_generation_job',
    'generation_job.processing': 'observation_generation_job',
    'generation_job.completed': 'observation_generation_job',
    'generation_job.failed': 'observation_generation_job',
    'generation_job.scope_violation': 'observation_generation_job',
    'generation_job.revoked_key': 'observation_generation_job',
    'generation_job.retried_by_operator': 'observation_generation_job',
    'generation_job.cancelled_by_operator': 'observation_generation_job',
    'generation_job.stalled': 'observation_generation_job',
    'settings.update': 'team_settings',
  };
  if (map[action]) return map[action]!;
  return action.split('.')[0] ?? 'unknown';
}

function preValidateBatch(
  req: Request,
  events: { projectId: string }[],
): BatchPreValidationFailure | null {
  const apiKeyProjectId = req.authContext?.projectId ?? null;
  const teamId = req.authContext?.teamId ?? null;
  if (!teamId) {
    return {
      status: 403,
      body: { error: 'Forbidden', message: 'API key is not bound to a team' },
    };
  }
  if (!apiKeyProjectId) {
    // No api-key project scope: every event must be in same team. Team
    // ownership is enforced by repos via `assertProjectOwnership`, but here
    // we only check the api-key cross-tenant bound.
    return null;
  }
  for (const event of events) {
    if (event.projectId !== apiKeyProjectId) {
      return {
        status: 403,
        body: {
          error: 'Forbidden',
          message: 'API key is scoped to a different project',
        },
      };
    }
  }
  return null;
}

function serializeSession(session: {
  id: string;
  projectId: string;
  teamId: string;
  externalSessionId: string | null;
  contentSessionId: string | null;
  agentId: string | null;
  agentType: string | null;
  platformSource: string | null;
  generationStatus: string;
  metadata: Record<string, unknown>;
  startedAtEpoch: number;
  endedAtEpoch: number | null;
  lastGeneratedAtEpoch: number | null;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}): Record<string, unknown> {
  return {
    id: session.id,
    projectId: session.projectId,
    teamId: session.teamId,
    externalSessionId: session.externalSessionId,
    contentSessionId: session.contentSessionId,
    agentId: session.agentId,
    agentType: session.agentType,
    platformSource: session.platformSource,
    generationStatus: session.generationStatus,
    metadata: session.metadata,
    startedAtEpoch: session.startedAtEpoch,
    endedAtEpoch: session.endedAtEpoch,
    lastGeneratedAtEpoch: session.lastGeneratedAtEpoch,
    createdAtEpoch: session.createdAtEpoch,
    updatedAtEpoch: session.updatedAtEpoch,
  };
}

function serializeEvent(event: PostgresAgentEvent): Record<string, unknown> {
  return {
    id: event.id,
    projectId: event.projectId,
    teamId: event.teamId,
    serverSessionId: event.serverSessionId,
    sourceAdapter: event.sourceAdapter,
    sourceEventId: event.sourceEventId,
    eventType: event.eventType,
    platformSource: event.platformSource,
    payload: event.payload,
    metadata: event.metadata,
    occurredAtEpoch: event.occurredAtEpoch,
    receivedAtEpoch: event.receivedAtEpoch,
    createdAtEpoch: event.createdAtEpoch,
  };
}

function serializeObservation(observation: {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  obsType?: string | null;
  lifecycleState?: string | null;
  supersededBy?: string | null;
  quality?: number | null;
}): Record<string, unknown> {
  return {
    id: observation.id,
    projectId: observation.projectId,
    teamId: observation.teamId,
    serverSessionId: observation.serverSessionId,
    kind: observation.kind,
    content: observation.content,
    // The viewer's adaptObservations reads obsType/lifecycleState to render the
    // observation's type badge and lifecycle. Include them so the Observations
    // tab shows typed, correctly-bucketed rows instead of untyped blanks.
    obsType: observation.obsType ?? null,
    lifecycleState: observation.lifecycleState ?? null,
    // Expose the quality score the ingest gate computed (ingest-quality.ts) and
    // the generation path stamps (processGeneratedResponse.ts). Without it a
    // client could not tell whether scoring ran at all — only that a submission
    // was not 422'd, which proves it met the floor but not what it scored. That
    // ambiguity cost real diagnosis time on 2026-08-13.
    quality: observation.quality ?? null,
    metadata: observation.metadata,
    createdAtEpoch: observation.createdAtEpoch,
    updatedAtEpoch: observation.updatedAtEpoch,
    ...(observation.supersededBy ? { supersededBy: observation.supersededBy } : {}),
  };
}

interface ObservationWithSourceRow {
  id: string;
  project_id: string;
  team_id: string;
  server_session_id: string | null;
  kind: string;
  content: string;
  metadata: unknown;
  generation_key: string | null;
  created_by_job_id: string | null;
  created_at: Date;
  updated_at: Date;
  source_id_pk: string;
  source_type: string;
  source_id: string;
  generation_job_id: string | null;
  source_created_at: Date;
}

function serializeObservationWithSource(row: ObservationWithSourceRow): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.project_id,
    teamId: row.team_id,
    serverSessionId: row.server_session_id,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    generationKey: row.generation_key,
    createdByJobId: row.created_by_job_id,
    createdAtEpoch: new Date(row.created_at).getTime(),
    updatedAtEpoch: new Date(row.updated_at).getTime(),
    source: {
      id: row.source_id_pk,
      sourceType: row.source_type,
      sourceId: row.source_id,
      generationJobId: row.generation_job_id,
      createdAtEpoch: new Date(row.source_created_at).getTime(),
    },
  };
}

function serializeGenerationJob(
  job: PostgresObservationGenerationJob,
  enqueueState: 'enqueued' | 'queued_only' | 'skipped',
): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    bullmqJobId: job.bullmqJobId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    transport: enqueueState,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}

// `?wait=true` polls the outbox row until it reaches a terminal status
// (or hits WAIT_TIMEOUT_MS). The serialized payload reports `status`,
// `attempts`, and `lastError`-equivalents on the outbox row itself; the
// caller queries the observations endpoints to fetch the actual content.
function serializeJobStatusResponse(
  job: PostgresObservationGenerationJob,
  enqueueState: 'enqueued' | 'queued_only' | 'skipped',
): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    transport: enqueueState,
    bullmqJobId: job.bullmqJobId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}

function serializeGenerationJobStatus(
  job: PostgresObservationGenerationJob,
): Record<string, unknown> {
  return {
    id: job.id,
    projectId: job.projectId,
    teamId: job.teamId,
    sourceType: job.sourceType,
    sourceId: job.sourceId,
    agentEventId: job.agentEventId,
    serverSessionId: job.serverSessionId,
    jobType: job.jobType,
    status: job.status,
    bullmqJobId: job.bullmqJobId,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAtEpoch: job.nextAttemptAtEpoch,
    completedAtEpoch: job.completedAtEpoch,
    failedAtEpoch: job.failedAtEpoch,
    cancelledAtEpoch: job.cancelledAtEpoch,
    lastError: job.lastError,
    createdAtEpoch: job.createdAtEpoch,
    updatedAtEpoch: job.updatedAtEpoch,
  };
}
