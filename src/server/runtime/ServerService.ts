// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { Server, type RouteHandler } from '../../services/server/Server.js';
import { selectRuntime } from '../../services/hooks/runtime-selector.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  captureProcessStartToken,
  verifyPidFileOwnership,
  type PidInfo,
} from '../../supervisor/process-registry.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { ServerV1PostgresRoutes } from '../routes/v1/ServerV1PostgresRoutes.js';
import { setTrackedViewResolver } from '../middleware/postgres-auth.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { SettingsResolver } from '../settings/SettingsResolver.js';
import { GenerationProviderHolder } from '../generation/GenerationProviderHolder.js';
import { SessionsObservationsAdapter } from '../compat/SessionsObservationsAdapter.js';
import { SessionsSummarizeAdapter } from '../compat/SessionsSummarizeAdapter.js';
import { ActiveServerQueueManager } from './ActiveServerQueueManager.js';
import { ServerViewerRoutes } from './ServerViewerRoutes.js';
import { CredentialStore } from '../../services/identity/credential-store.js';
import {
  PROJECT_PATH_KEY,
  readProjectMarker as readProjectMarkerForTrackedView,
} from '../../services/identity/project-identity.js';
import { evaluateTrackedViewGrant } from '../middleware/tracked-view-grant.js';
import { teamReadProxy } from '../middleware/team-read-proxy-middleware.js';
import {
  isLocalhost,
  hasLoopbackHostHeader,
  hasForwardedClientHeaders,
} from '../middleware/request-auth-helpers.js';
import { hashApiKey } from '../../services/hooks/server-bootstrap.js';
import { resolveViewerKeyForRequest } from './viewer-project-scope.js';
import { DashboardRoutes } from '../dashboard/routes.js';
import type { ServerServiceGraph, ServerQueueLaneMetric } from './types.js';
import { assessGenerationHealth } from './generation-health.js';
import { defaultSpoolPath, readDroppedCount } from '../../cli/handlers/capture-spool.js';
import { generationQueuePath } from '../../services/generation/local-queue.js';
import { countEmbeddingCoverage } from './embedding-backfill.js';

// Phase 1d retains the persisted runtime literal `'server-beta'`. Renaming the
// constant here keeps the TS identifier modern while preserving wire/storage
// back-compat. Plan §1d will handle the literal migration.
const SERVER_RUNTIME = 'server-beta';
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 38877;

export interface ServerServiceOptions {
  graph: ServerServiceGraph;
  host?: string;
  port?: number;
  persistRuntimeState?: boolean;
}

export interface ServerRuntimeState {
  runtime: typeof SERVER_RUNTIME;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  bootstrap: ServerServiceGraph['postgres']['bootstrap'];
  boundaries: {
    queueManager: ReturnType<ServerServiceGraph['queueManager']['getHealth']>;
    generationWorkerManager: ReturnType<ServerServiceGraph['generationWorkerManager']['getHealth']>;
  };
}

class ServerRuntimeInfoRoutes implements RouteHandler {
  constructor(private readonly graph: ServerServiceGraph) {}

  setupRoutes(app: Application): void {
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', runtime: SERVER_RUNTIME });
    });

    // Phase 12 — `/v1/info` includes per-lane queue metrics so deploy probes
    // can read waiting/active/completed/failed/delayed/stalled without
    // hitting `/api/health`. Sampling is best-effort: a Redis blip surfaces
    // the lane with `unavailable: true` rather than crashing the route.
    app.get('/v1/info', async (_req, res) => {
      const queueLanes = await collectQueueLaneMetrics(this.graph);
      // `boundaries` reports whether the machinery is WIRED UP. It reported
      // healthy through fifteen hours of total generation failure, because the
      // queue itself was fine — the provider had died. `generation` below answers
      // the different and more useful question: is memory actually being
      // distilled right now?
      const generation = await collectGenerationHealth(this.graph);
      // Embedding coverage: a NULL-embedding observation exists but is invisible
      // to semantic search, which to a user is indistinguishable from the memory
      // not being there. Two such rows went unnoticed for two weeks because
      // nothing reported them.
      const embeddings = await countEmbeddingCoverage(this.graph.postgres.pool);
      // Cheapest possible liveness probe. Everything downstream — capture,
      // recall, the drain — is dead the moment Postgres is, so this is the one
      // fact worth knowing first.
      let pgReachable = false;
      try {
        await this.graph.postgres.pool.query('SELECT 1');
        pgReachable = true;
      } catch {
        pgReachable = false;
      }
      res.json({
        name: 'memsmith-server',
        runtime: SERVER_RUNTIME,
        authMode: this.graph.authMode,
        postgres: {
          initialized: this.graph.postgres.bootstrap.initialized,
          schemaVersion: this.graph.postgres.bootstrap.schemaVersion,
          // `initialized`/`schemaVersion` describe BOOT, and stay true forever
          // once set — they said "healthy" even if Postgres died minutes later.
          // `reachable` is the live answer, because everything (capture,
          // recall, the drain) is dead the moment the database is.
          reachable: pgReachable,
        },
        boundaries: {
          queueManager: this.graph.queueManager.getHealth(),
          generationWorkerManager: this.graph.generationWorkerManager.getHealth(),
        },
        queueLanes,
        generation,
        embeddings,
      });
    });
  }
}

// Real probes for the generation-health question. All best-effort: assess*
// degrades to 'unknown' rather than claiming health it has not verified, and the
// route must never throw on a probe blip.
async function collectGenerationHealth(graph: ServerServiceGraph) {
  const pool = graph.postgres.pool;
  // Is generation delegated to the clients? A team server under local generation
  // runs with MEMSMITH_GENERATION_DISABLED and has no provider BY DESIGN, so the
  // unreachable-provider and standing-backlog findings are not faults there.
  // Read from the same env the disable decision uses
  // (create-server-service.ts:230-231) so the two can never disagree.
  const generationDelegated = process.env.MEMSMITH_GENERATION_DISABLED === '1'
    || process.env.MEMSMITH_GENERATION_DISABLED === 'true';
  return assessGenerationHealth({
    now: () => new Date(),
    generationDelegated,
    // Surface work the local spool discarded. Reads BOTH spools: the capture spool
    // (events that never reached the server) and the generation queue (team-mode
    // observations awaiting delivery), since they overflow independently.
    droppedCaptures: () => {
      try {
        const totals = [defaultSpoolPath(), generationQueuePath()]
          .map(readDroppedCount)
          .filter((d): d is { droppedTotal: number; lastDroppedAt: string } => d !== null);
        if (totals.length === 0) return null;
        return {
          droppedTotal: totals.reduce((sum, d) => sum + d.droppedTotal, 0),
          lastDroppedAt: totals.map(d => d.lastDroppedAt).sort().reverse()[0] ?? '',
        };
      } catch {
        return null;
      }
    },
    counts: async () => {
      const r = await pool.query(
        `SELECT
           count(*) FILTER (WHERE status = 'queued')     AS queued,
           count(*) FILTER (WHERE status = 'processing') AS processing,
           count(*) FILTER (WHERE status = 'completed'
                              AND completed_at > now() - interval '1 hour') AS recent
         FROM observation_generation_jobs`,
      );
      const row = (r.rows[0] ?? {}) as Record<string, unknown>;
      return {
        queued: Number(row.queued ?? 0),
        processing: Number(row.processing ?? 0),
        completedLastHour: Number(row.recent ?? 0),
      };
    },
    lastCompletedAt: async () => {
      const r = await pool.query(
        `SELECT max(completed_at) AS last FROM observation_generation_jobs WHERE status = 'completed'`,
      );
      const last = (r.rows[0] as { last?: unknown } | undefined)?.last;
      return last instanceof Date ? last : (typeof last === 'string' ? new Date(last) : null);
    },
    providerReachable: async () => {
      // No live reachability probe exists on the graph today, so this reports
      // whether a provider is CONFIGURED at all — which still catches the
      // "generation disabled, nothing can ever be produced" case.
      //
      // It does NOT catch a configured-but-dead provider (ollama not running),
      // which is precisely what failed for fifteen hours. The queued+stale
      // signal above is what covers that case: a dead provider produces a
      // growing backlog with no completions, and that IS detected. Reporting a
      // true/false here that we cannot actually verify would be the same
      // unverified-health claim this whole check exists to eliminate.
      const health = graph.generationWorkerManager.getHealth();
      return health?.status !== 'disabled';
    },
  });
}

async function collectQueueLaneMetrics(
  graph: ServerServiceGraph,
): Promise<ServerQueueLaneMetric[]> {
  const manager = graph.queueManager;
  if (!(manager instanceof ActiveServerQueueManager)) {
    return [];
  }
  try {
    return await manager.getLaneMetrics();
  } catch {
    // /api/health and /v1/info MUST never throw on a queue blip — surface
    // empty lanes so the rest of the payload still renders.
    return [];
  }
}

export class ServerService {
  private readonly graph: ServerServiceGraph;
  private readonly host: string;
  private readonly requestedPort: number;
  private boundPort: number | null = null;
  private readonly persistRuntimeState: boolean;
  private server: Server | null = null;
  private stopping = false;

  constructor(options: ServerServiceOptions) {
    this.graph = options.graph;
    this.host = options.host ?? process.env.MEMSMITH_SERVER_HOST ?? DEFAULT_SERVER_HOST;
    this.requestedPort = options.port ?? getServerPort();
    this.persistRuntimeState = options.persistRuntimeState ?? true;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = new Server({
      // #2572 — server runtime is reachable over the network in Docker, so it
      // emits hardening headers (the worker, loopback-only, does not).
      securityHeaders: true,
      getInitializationComplete: () => this.graph.postgres.bootstrap.initialized,
      getMcpReady: () => true,
      onShutdown: () => this.stop(),
      onRestart: async () => {
        await this.stop();
        await this.start();
      },
      workerPath: '',
      runtime: SERVER_RUNTIME,
      getAiStatus: () => ({
        provider: 'disabled',
        authMethod: this.graph.authMode,
        lastInteraction: null,
      }),
      // Phase 10 — surface BullMQ/Valkey health on /api/health so deploy
      // probes (and the Docker E2E) can confirm the queue engine without
      // peeking at /v1/info. The queue manager's getHealth() returns its
      // boundary descriptor; we shape it into the worker-compatible
      // ObservationQueueHealth schema the Server class expects.
      // Phase 12 — also include per-lane counts (waiting/active/completed/
      // failed/delayed/stalled) so deploy probes can monitor saturation.
      getQueueHealth: async () => {
        const health = this.graph.queueManager.getHealth();
        const details = (health.details ?? {}) as Record<string, unknown>;
        if (health.status !== 'active' || details.engine !== 'bullmq') {
          return null;
        }
        const lanes = await collectQueueLaneMetrics(this.graph);
        return {
          engine: 'bullmq' as const,
          redis: {
            status: 'ok' as const,
            mode: String(details.mode ?? 'unknown'),
            host: String(details.host ?? '127.0.0.1'),
            port: typeof details.port === 'number' ? details.port : 6379,
            prefix: String(details.prefix ?? 'memsmith'),
          },
          lanes: lanes.map(lane => ({
            kind: lane.kind,
            name: lane.name,
            waiting: lane.waiting,
            active: lane.active,
            completed: lane.completed,
            failed: lane.failed,
            delayed: lane.delayed,
            stalled: lane.stalled,
            unavailable: lane.unavailable,
            ...(lane.unavailableReason ? { unavailableReason: lane.unavailableReason } : {}),
          })),
        };
      },
    });
    server.registerRoutes(new ServerRuntimeInfoRoutes(this.graph));
    const settingsStore = new SettingsStore(this.graph.postgres.pool);
    const settingsResolver = new SettingsResolver(settingsStore);
    // Task 8: build a GenerationProviderHolder from the settings resolver so
    // POST /v1/record-intent can resolve the live provider per request.
    const generationProviderHolder = new GenerationProviderHolder(settingsResolver);
    const v1Routes = new ServerV1PostgresRoutes({
      pool: this.graph.postgres.pool,
      queueManager: this.graph.queueManager,
      authMode: this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode,
      allowLocalDevBypass: process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS === '1',
      localDevTeamId: this.graph.localDevTeamId,
      localDevProjectId: this.graph.localDevProjectId,
      // Read-only view of a TRACKED project: a fresh clone of a team project,
      // whose marker this machine can see but whose key it does not hold. No
      // credential can authenticate such a project, so without this the
      // dashboard cannot display it and its Join button never renders.
      //
      // Wired here because the gate needs the project's RECORDED path (from
      // projects.metadata) — never the server's cwd, which names an unrelated
      // project on a server that handles many.
      resolveTrackedView: async (req) => {
        // ACCEPT BOTH SPELLINGS. The browser-facing viewer route reads
        // `?project=` (ServerViewerRoutes: `req.query?.project`) while the /v1
        // API uses `?projectId=`. This grant originally read only projectId, so
        // the URL a user actually opens — the one the SessionStart banner prints,
        // with ?project= — never reached it and the dashboard silently stayed on
        // whatever the cookie already held.
        const q = req.query as Record<string, unknown> | undefined;
        const raw = typeof q?.projectId === 'string' ? q.projectId
          : typeof q?.project === 'string' ? q.project
          : undefined;
        const requested = raw;
        if (!requested?.trim()) return null;
        let marker: { teamId: string; projectId: string; runtime?: string } | null = null;
        try {
          const r = await this.graph.postgres.pool.query(
            'SELECT metadata FROM projects WHERE id = $1', [requested],
          );
          const metadata = (r.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
          const path = metadata?.[PROJECT_PATH_KEY];
          if (typeof path !== 'string' || !path.trim()) return null;
          marker = readProjectMarkerForTrackedView(path);
        } catch {
          return null;
        }
        const store = new CredentialStore();
        return evaluateTrackedViewGrant({
          hasKey: false, // only called when no credential was presented
          isLoopbackIp: isLocalhost(req as never),
          isLoopbackHost: hasLoopbackHostHeader(req as never),
          hasForwardedHeaders: hasForwardedClientHeaders(req as never),
          requestedProjectId: requested,
          marker,
          machineHoldsTeamKey: Boolean(marker && store.resolveKeyForTeam(marker.teamId)),
        });
      },
      settingsStore,
      settingsResolver,
      generationProviderHolder,
      poolRegistry: this.graph.poolRegistry,
      baseDatabaseName: this.graph.baseDatabaseName,
      baseProjectId: this.graph.baseProjectId ?? null,
    });
    // REGISTER THE TRACKED-VIEW RESOLVER PROCESS-WIDE.
    //
    // There are nine requirePostgresServerAuth(...) construction sites — the v1
    // routes, /v1/identity's own middleware, the dashboard routes and two compat
    // adapters. Threading the resolver through each one by hand failed twice:
    // /v1/identity answered 200 for a tracked project while every /dashboard/*
    // endpoint 401'd, so the UI rendered "Not authenticated" and never reached
    // the Join button. A cross-cutting auth capability wired per-site is a
    // capability that will be missing somewhere.
    //
    // One registration here; every middleware inherits it, and an explicit
    // per-site option still wins for tests.
    setTrackedViewResolver(v1Routes.trackedViewResolver ?? null);
    server.registerRoutes(v1Routes);

    // Phase 9 — legacy compatibility adapters. These translate the old
    // `/api/sessions/observations` and `/api/sessions/summarize` worker
    // routes to the canonical Server event/job model. They share the
    // SAME shared services with /v1/* routes — never duplicate ingest or
    // session-end logic. New clients should hit /v1/* directly.
    const compatAuthMode = this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode;
    server.registerRoutes(new SessionsObservationsAdapter({
      pool: this.graph.postgres.pool,
      ingestEvents: v1Routes.getIngestEventsService(),
      authMode: compatAuthMode,
      // GET /api/observations (viewer list) must honor the same loopback
      // local-dev bypass as the /v1 + /dashboard reads, else the viewer's
      // Observations tab 403s in local mode.
      allowLocalDevBypass: process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS === '1',
      localDevTeamId: this.graph.localDevTeamId ?? null,
      localDevProjectId: this.graph.localDevProjectId ?? null,
      // Critical 2 fix — same per-request routing wiring as v1Routes/DashboardRoutes
      // below, so these legacy adapters stop writing project data to the base pool.
      poolRegistry: this.graph.poolRegistry,
      baseDatabaseName: this.graph.baseDatabaseName,
      baseProjectId: this.graph.baseProjectId ?? null,
    }));
    server.registerRoutes(new SessionsSummarizeAdapter({
      pool: this.graph.postgres.pool,
      endSession: v1Routes.getEndSessionService(),
      authMode: compatAuthMode,
      poolRegistry: this.graph.poolRegistry,
      baseDatabaseName: this.graph.baseDatabaseName,
      baseProjectId: this.graph.baseProjectId ?? null,
    }));

    // #2552 — mount the Viewer UI static handler so the viewer loads on the
    // server runtime. Registered AFTER the /v1 and compat API routes so the
    // viewer's own API calls resolve against those; express.static only
    // matches existing files and the `/` GET only matches the root, so this
    // never shadows an API route.
    // In local runtime the browser is the machine owner, and this machine has
    // already minted a base key for its team. Hand that key to a loopback
    // browser so the dashboard can read its own data; without it the viewer
    // sends no credential and every read 401s. Deliberately NOT wired for the
    // server/team runtime, where the operator authenticates normally and no
    // machine-local credential should be issued.
    // Condition: this machine has a local project marker (localDevTeamId) AND
    // holds that team's key in its own CredentialStore. Both are true only for
    // a local install, and the second is the actual precondition anyway -- a
    // team-mode server has no local credential file to read, so resolveKeyFor-
    // Team returns null and no cookie is issued.
    //
    // NB: do NOT gate on process.env.MEMSMITH_RUNTIME. That setting lives in
    // ~/.memsmith/settings.json, not the process environment, so reading it
    // here evaluates false on a real local install and silently disables the
    // cookie -- which is exactly how the first cut of this fix failed.
    const localTeamId = this.graph.localDevTeamId ?? null;
    server.registerRoutes(new ServerViewerRoutes({
      // A throwing resolver cannot break the page — ServerViewerRoutes wraps
      // this call — so no defensive try/catch is duplicated here.
      //
      // ?project= picks WHICH project's key is handed over, so the dashboard
      // and the Go Team wizard act on the project being viewed rather than the
      // one the server booted from. Only keys this machine already holds are
      // issued; anything else falls back to the server's own project.
      resolveLocalKey: localTeamId
        ? (requestedProjectId?: string) => {
          const store = new CredentialStore();
          return resolveViewerKeyForRequest({
            requestedProjectId,
            serverTeamId: localTeamId,
            lookupTeamForProject: async (projectId: string) => {
              const r = await this.graph.postgres.pool.query(
                'SELECT team_id FROM projects WHERE id = $1', [projectId],
              );
              return (r.rows[0] as { team_id?: string } | undefined)?.team_id ?? null;
            },
            // Per-project first: after a JOIN two local projects share one team,
            // and CredentialStore is keyed by team alone, so the team lookup
            // below would hand both projects the same key. api_keys is
            // per-project and is what authContext already derives from.
            //
            // The stored key_hash is a SHA-256 of the plaintext and cannot be
            // reversed, so this matches the project's row against the plaintexts
            // this machine actually holds — issuing only a credential already on
            // this disk, exactly as the team path does.
            resolveKeyForProject: async (projectId: string) => {
              const r = await this.graph.postgres.pool.query(
                'SELECT key_hash FROM api_keys WHERE project_id = $1', [projectId],
              );
              const hashes = new Set(
                (r.rows as Array<{ key_hash?: string }>).map(x => x.key_hash).filter(Boolean) as string[],
              );
              if (!hashes.size) return null;
              for (const teamId of store.listTeamIdsWithKeys()) {
                const plaintext = store.resolveKeyForTeam(teamId);
                if (plaintext && hashes.has(hashApiKey(plaintext))) return plaintext;
              }
              return null;
            },
            resolveKeyForTeam: (teamId: string) => store.resolveKeyForTeam(teamId),
          });
        }
        : undefined,
    }));

    // Team dashboard — the "only us" team views (lifecycle board, decision log
    // with supersession lineage, blocked-on-whom, cost). Auth-gated by
    // memories:read like the /v1 reads, reading the same shared Postgres store.
    // Mounted on-by-default (safe: read-only, scoped). Registered AFTER /v1 +
    // compat so its /dashboard/* data routes never shadow an API route.
    server.registerRoutes(new DashboardRoutes({
      db: this.graph.postgres.pool,
      authMode: this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode,
      localDevTeamId: this.graph.localDevTeamId,
      localDevProjectId: this.graph.localDevProjectId,
      settingsResolver,
      poolRegistry: this.graph.poolRegistry,
      baseDatabaseName: this.graph.baseDatabaseName,
      baseProjectId: this.graph.baseProjectId ?? null,
      // A JOINED project's memory lives on its team server, and this server
      // cannot validate a team-issued key — so without this the dashboard showed
      // "Not authenticated" and no data right after a successful join. Resolves
      // the marker via the path the PROJECT recorded, never the server's cwd.
      teamReadProxy: teamReadProxy({
        lookupMarker: async (projectId: string) => {
          try {
            const r = await this.graph.postgres.pool.query(
              'SELECT metadata FROM projects WHERE id = $1', [projectId],
            );
            const metadata = (r.rows[0] as { metadata?: Record<string, unknown> | null } | undefined)?.metadata;
            const path = metadata?.[PROJECT_PATH_KEY];
            if (typeof path !== 'string' || !path.trim()) return null;
            return readProjectMarkerForTrackedView(path);
          } catch {
            return null;
          }
        },
        resolveTeamKey: (teamId: string) => new CredentialStore().resolveKeyForTeam(teamId),
      }),
    }));

    server.finalizeRoutes();

    await server.listen(this.requestedPort, this.host);
    this.server = server;
    this.boundPort = resolveBoundPort(server) ?? this.requestedPort;
    if (this.persistRuntimeState) {
      writeServerState(this.runtimeState());
    }
    logger.info('SYSTEM', 'Server started', { host: this.host, port: this.boundPort, pid: process.pid });
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    try {
      if (this.server) {
        try {
          await this.server.close();
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          if ((err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            throw error;
          }
          logger.warn('SYSTEM', 'Server was already stopped when close was requested', {}, err);
        }
        this.server = null;
      }
      await Promise.all([
        this.graph.queueManager.close(),
        this.graph.generationWorkerManager.close(),
        this.graph.poolRegistry?.closeAll() ?? Promise.resolve(),
      ]);
      await this.graph.postgres.pool.end();
    } finally {
      if (this.persistRuntimeState) {
        removeServerState();
      }
      this.boundPort = null;
      this.stopping = false;
      logger.info('SYSTEM', 'Server stopped');
    }
  }

  getRuntimeState(): ServerRuntimeState {
    return this.runtimeState();
  }

  private runtimeState(): ServerRuntimeState {
    return {
      runtime: SERVER_RUNTIME,
      pid: process.pid,
      port: this.boundPort ?? this.requestedPort,
      host: this.host,
      startedAt: new Date().toISOString(),
      bootstrap: this.graph.postgres.bootstrap,
      boundaries: {
        queueManager: this.graph.queueManager.getHealth(),
        generationWorkerManager: this.graph.generationWorkerManager.getHealth(),
      },
    };
  }
}

function resolveBoundPort(server: Server): number | null {
  const address = server.getHttpServer()?.address();
  return address && typeof address !== 'string' ? address.port : null;
}

// #2444 — `start` is foreground by default; `--daemon`/`-d` opts into the
// detached background daemon. Exported so the CLI contract is unit-testable
// without spawning a real service.
export function startCommandWantsDaemon(startArgs: string[]): boolean {
  return startArgs.some(flag => flag === '--daemon' || flag === '-d');
}

// Decides which path bare/`--daemon` `start` takes. Pure + exported for unit
// tests. Priority: a running server is always reused first; then local auto-
// detaches (a SessionStart hook cannot host the blocking foreground server
// loop, so local MUST daemonize) or an explicit --daemon detaches; otherwise
// server-mode runs foreground (systemd Type=simple owns the process). See
// 2026-07-24-start-autodaemonize-local spec.
export function resolveStartAction(input: {
  wantsDaemon: boolean;
  isLocal: boolean;
  hasRunningServer: boolean;
}): 'reuse' | 'daemon' | 'foreground' {
  if (input.hasRunningServer) return 'reuse';
  if (input.wantsDaemon || input.isLocal) return 'daemon';
  return 'foreground';
}

export async function runServerServiceCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? '--daemon';
  const port = getServerPort();
  const host = process.env.MEMSMITH_SERVER_HOST ?? DEFAULT_SERVER_HOST;

  // `hook <platform> <event>` — plugin capture hooks (claude-code, codex, etc.)
  // IO discipline: once hookCommand is invoked, src/shared/hook-io.ts owns all
  // stdout/stderr/exit. The pre-hookCommand error paths below are CLI-style:
  // console.error + exit 1 is acceptable because they occur BEFORE the
  // buffered window opens. argv[0]='hook', argv[1]=platform, argv[2]=event
  // (argv is process.argv.slice(2) so these map to process.argv[2..4]).
  if (command === 'hook') {
    const platform = argv[1];
    const event = argv[2];
    if (!platform || !event) {
      console.error('Usage: memsmith hook <platform> <event>');
      console.error('Platforms: claude-code, codex, cursor, antigravity-cli, raw');
      console.error('Events: context, session-init, observation, summarize, user-message');
      process.exit(1);
    }
    const { hookCommand } = await import('../../cli/hook-command.js');
    const code = await hookCommand(platform, event);
    process.exit(code);
  }

  // Phase 10: `memsmith server worker [start|--daemon]` runs the BullMQ
  // generation worker as a foregrounded process — no HTTP server, no route
  // registration. In Compose this becomes a separately scaled service.
  if (command === 'worker') {
    const sub = (argv[1] ?? '--daemon').toLowerCase();
    if (sub === 'start' || sub === '--daemon' || sub === 'run') {
      await runServerGenerationWorker();
      return;
    }
    console.error('Usage: server-service worker start');
    process.exit(1);
  }

  // `server api-key create|list|revoke|migrate-scopes` mirrors the
  // worker-service tooling but writes to the Postgres `api_keys` table the
  // server runtime actually reads from. The legacy worker-service CLI
  // talks to SQLite and would be invisible to this stack.
  if (command === 'server' && argv[1]?.toLowerCase() === 'api-key') {
    await runServerApiKeyCli(argv.slice(2));
    return;
  }

  // #2572 — `server keys` lists ACTIVE keys (never printing secrets) and
  // `server jobs` lists/inspects queued generation jobs. Both read the
  // Postgres backend the server runtime uses. `keys` is an alias for
  // `api-key list --active`.
  if (command === 'server' && argv[1]?.toLowerCase() === 'keys') {
    await runServerApiKeyCli(['list', '--active', ...argv.slice(2)]);
    return;
  }
  if (command === 'server' && argv[1]?.toLowerCase() === 'jobs') {
    await runServerJobsCli(argv.slice(2));
    return;
  }

  switch (command) {
    case 'start': {
      const existing = readServerPidFile();
      const hasRunningServer = verifyPidFileOwnership(existing);
      const wantsDaemon = startCommandWantsDaemon(argv.slice(1));
      const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
      const isLocal = selectRuntime(cwd) === 'local';

      const action = resolveStartAction({ wantsDaemon, isLocal, hasRunningServer });

      if (action === 'reuse') {
        console.log(JSON.stringify({ status: 'ready', runtime: SERVER_RUNTIME, pid: existing!.pid, port: existing!.port }));
        return;
      }

      if (action === 'daemon') {
        // Detached so the caller (e.g. the short-lived SessionStart hook) does
        // NOT block in the server loop. The child re-enters via `--daemon` →
        // runRuntimeForeground, which boots local or server per selectRuntime.
        // #2444 — `start` runs in the FOREGROUND by default so the server is
        // usable under systemd `Type=simple` (the supervisor owns the PID and
        // restart policy). Detached daemonization is an explicit opt-in via
        // `start --daemon`, preserving the old behavior for ad-hoc local use.
        const daemonPid = spawnServerDaemon(port);
        if (daemonPid === undefined) {
          console.error('Failed to spawn server daemon.');
          process.exit(1);
        }
        console.log(JSON.stringify({ status: 'starting', runtime: SERVER_RUNTIME, pid: daemonPid, port }));
        return;
      }

      // action === 'foreground' — server-mode default (systemd Type=simple).
      await runRuntimeForeground(port, host);
      return;
    }

    case 'stop': {
      const existing = readServerPidFile();
      if (!verifyPidFileOwnership(existing)) {
        removeServerState();
        console.log('Server is not running');
        return;
      }
      process.kill(existing.pid, 'SIGTERM');
      await waitForPidExit(existing.pid, 5000);
      removeServerState();
      console.log('Server stopped');
      return;
    }

    case 'restart': {
      // restart implies a managed background daemon (there is no foreground
      // process to hand control back to), so it re-spawns detached.
      await runServerServiceCli(['stop']);
      await runServerServiceCli(['start', '--daemon']);
      return;
    }

    case 'status': {
      const state = readServerRuntimeState();
      const pidInfo = readServerPidFile();
      if (state && verifyPidFileOwnership(pidInfo)) {
        console.log('Server is running');
        console.log(`  PID: ${state.pid}`);
        console.log(`  Port: ${state.port}`);
        console.log(`  Runtime: ${state.runtime}`);
        console.log(`  Started: ${state.startedAt}`);
      } else {
        console.log('Server is not running');
      }
      return;
    }

    case '--daemon': {
      // Internal entrypoint executed by the detached child spawned via
      // `start --daemon`. Runs the same foreground loop in the child process.
      await runRuntimeForeground(port, host);
      return;
    }

    default:
      console.error('Usage: server-service start [--daemon] | stop | restart | status');
      console.error('  start            run the server in the foreground (default; systemd Type=simple)');
      console.error('  start --daemon   detach and run as a background daemon');
      console.error('  stop             stop a running daemon');
      console.error('  restart          stop then start (daemon)');
      console.error('  status           print runtime status');
      console.error('  server api-key create|list|revoke|migrate-scopes   manage Postgres API keys');
      console.error('  server keys                                        alias for api-key list --active (no secrets)');
      console.error('  server jobs [list|inspect <id>]                    list/inspect generation jobs');
      process.exit(1);
  }
}

// #2444 — shared foreground run loop. Builds the service in THIS process,
// installs signal handlers, and blocks until shutdown. Used both by `start`
// (default, foreground) and by the internal `--daemon` child process.
async function runServerForeground(port: number, host: string): Promise<void> {
  const existing = readServerPidFile();
  if (verifyPidFileOwnership(existing) || await isPortInUse(port, host)) {
    process.exit(0);
  }
  const { createServerService } = await import('./create-server-service.js');
  const service = await createServerService();
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await service.start();
}

// Exported for the local runtime, which boots embedded PG then runs the same
// foreground service loop. Mirrors the `server start` port/host resolution.
export async function runServerForegroundForLocal(): Promise<void> {
  const port = getServerPort();
  const host = process.env.MEMSMITH_SERVER_HOST ?? DEFAULT_SERVER_HOST;
  await runServerForeground(port, host);
}

// Runtime-aware foreground entry used by `start` (foreground) and the internal
// `--daemon` child. When the resolved runtime is local, boot the embedded PG +
// server loop (startLocalRuntime). When it is 'server' (team mode), start the
// local generation loop instead of a full server — createServerService()
// hard-requires MEMSMITH_SERVER_DATABASE_URL and MEMSMITH_REDIS_URL
// (create-server-service.ts), which a laptop never has configured, so
// falling through to startServer() there fails outright. Team mode's
// generation now runs on THIS machine (Task 1/4/5's queue + pool-free
// generator), so the laptop only needs to drain that queue, not host the
// whole server stack. The deps object is a test seam; production omits it.
export interface RuntimeForegroundDeps {
  selectRuntime?: (cwd: string) => 'local' | 'server';
  startLocal?: () => Promise<void>;
  startServer?: (port: number, host: string) => Promise<void>;
  startGenerationLoop?: () => Promise<void>;
}
export async function runRuntimeForeground(
  port: number,
  host: string,
  deps: RuntimeForegroundDeps = {},
): Promise<void> {
  const pick = deps.selectRuntime ?? selectRuntime;
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  if (pick(cwd) === 'local') {
    const startLocal = deps.startLocal ?? (async () => {
      const { startLocalRuntime } = await import('./local-runtime.js');
      await startLocalRuntime();
    });
    await startLocal();
    return;
  }
  // 'server' runtime covers TWO very different machines, and they need
  // different things:
  //
  //   a real server (AWS Fargate, systemd) — has MEMSMITH_SERVER_DATABASE_URL
  //     and MEMSMITH_REDIS_URL injected, and must run the HTTP server. The
  //     container entrypoint reaches here via `--daemon`, so returning the
  //     generation loop instead would leave the deployment with no HTTP
  //     listener at all.
  //
  //   a teammate's laptop in team mode — has NEITHER of those, so
  //     createServerService() throws (create-server-service.ts:151-158). That
  //     failure is the bug this whole change exists to fix; the laptop should
  //     run the local generation loop instead.
  //
  // selectRuntime cannot tell them apart (both are 'server'), so discriminate
  // on the database URL: its presence is what makes startServer viable at all.
  const hasServerDatabase = Boolean((process.env.MEMSMITH_SERVER_DATABASE_URL ?? '').trim());
  if (hasServerDatabase) {
    const startServer = deps.startServer ?? runServerForeground;
    await startServer(port, host);
    return;
  }
  const startGenerationLoop = deps.startGenerationLoop ?? (async () => {
    const { startGenerationLoop: run } = await import('../../services/generation/start-generation-loop.js');
    await run();
  });
  await startGenerationLoop();
}

// Phase 10 — Postgres-backed `server api-key create|list|revoke` CLI. The
// legacy `worker-service.cjs server api-key` command talks to SQLite and
// is invisible to the server runtime, which reads keys from Postgres. Use
// this entrypoint inside Docker / Compose.
// #2572 — wrong-runtime guard.
//
// The server operability commands (`api-key`, `keys`, `jobs`) only make
// sense in the server runtime, whose canonical store is Postgres. If they
// are invoked in a worker-only context — `MEMSMITH_RUNTIME` set to `worker`,
// or no `MEMSMITH_SERVER_DATABASE_URL` configured — we fail fast with an
// actionable message instead of crashing later with an opaque pool error.
//
// Phase 1d: dual-accept the persisted runtime literal (`'server'` is the new
// canonical form; `'server-beta'` remains valid for existing installs).
export function assertServerRuntimeForCli(
  commandLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const runtime = (env.MEMSMITH_RUNTIME ?? '').trim().toLowerCase();
  if (runtime && runtime !== 'server' && runtime !== 'server-beta') {
    throw new Error(
      `\`server ${commandLabel}\` is a server runtime command, but MEMSMITH_RUNTIME=${runtime}. ` +
        'Set MEMSMITH_RUNTIME=server (and MEMSMITH_SERVER_DATABASE_URL) to run server operations, ' +
        'or use the worker CLI (`worker-service ...`) for the worker runtime.',
    );
  }
  if (!(env.MEMSMITH_SERVER_DATABASE_URL ?? '').trim()) {
    throw new Error(
      `MEMSMITH_SERVER_DATABASE_URL is required for \`server ${commandLabel}\`. ` +
        'This command talks to the server Postgres backend; export the connection string before running it.',
    );
  }
}

export async function runServerApiKeyCli(argv: string[]): Promise<void> {
  const sub = argv[0]?.toLowerCase();
  const options = parseFlagArgs(argv.slice(1));

  try {
    assertServerRuntimeForCli('api-key');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // #2560 — `api-key migrate-scopes <id>` brings a key's scope set up to a
  // working default (or an explicit --scope list). The pure helper
  // migrateServerApiKeyScopes() backs the SQLite path; here we apply the same
  // semantics against the Postgres `api_keys` table the server runtime
  // reads from.
  if (sub === 'migrate-scopes') {
    await migrateServerPostgresApiKeyScopes(argv.slice(1));
    return;
  }

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const { PostgresAuthRepository } = await import('../../storage/postgres/auth.js');
  const { createHash, randomBytes } = await import('crypto');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  const repo = new PostgresAuthRepository(pool);

  try {
    if (sub === 'create') {
      const scopes = (options.scope ?? options.scopes ?? 'memories:read')
        .split(',')
        .map((scope: string) => scope.trim())
        .filter(Boolean);
      // Resolve team/project. If the caller passed --team/--project, honor
      // them. Otherwise, run the server bootstrap to get-or-create the
      // local team+project, then create a NEW key against those IDs with
      // the caller's requested scopes (the bootstrap key uses hook scopes,
      // which is the wrong default for an arbitrary CLI-issued key).
      let teamId = options.team ?? null;
      let projectId = options.project ?? null;
      // TEAM-WIDE KEYS. project_id IS NULL is not "unset" — it is the documented
      // way a key spans every project in its team (see the entitlement rule in
      // resolve-requested-project.ts: a team-scoped key may narrow to any project
      // belonging to its team, and never to another team's).
      //
      // `--team X` with no `--project` used to fall into the bootstrap branch and
      // silently OVERWRITE both ids with a locally-created team+project, so the
      // caller got a key for the wrong tenant and team-wide keys were unmintable.
      // An explicit --team is now honoured on its own; bootstrap applies only
      // when the caller named neither.
      if (!teamId && !projectId) {
        const { bootstrapServerApiKey } = await import('../../services/hooks/server-bootstrap.js');
        const result = await bootstrapServerApiKey({ pool, closePool: false });
        teamId = result.teamId;
        projectId = result.projectId;
      } else if (!teamId) {
        // A project without its team cannot be scoped or ownership-checked.
        console.error('--project requires --team');
        process.exit(1);
      }
      // ROLE-BEARING KEYS. Role is NOT a property of the key: postgres-auth.ts
      // resolves it by joining team_members on the key's user_id. A key minted
      // without --user therefore has user_id=null -> role=null -> every
      // requireRole() route 403s, including POST /v1/keys.
      //
      // That was a bootstrap dead end on a private-RDS deployment: the only way
      // to mint an admin key was POST /v1/keys, which itself requires admin.
      // `--user <id> [--role <role>]` breaks the cycle by writing the
      // team_members row and linking the key to it in ONE transaction, so a
      // deployment can create its first owner without direct SQL access.
      const userId = options.user ?? options.userId ?? null;
      const role = options.role ?? (userId ? 'owner' : null);
      const VALID_ROLES = ['owner', 'admin', 'member', 'viewer'];
      if (role != null && !VALID_ROLES.includes(role)) {
        console.error(`Invalid --role '${role}'. Expected one of: ${VALID_ROLES.join(', ')}`);
        process.exit(1);
      }
      if (role != null && userId == null) {
        console.error('--role requires --user (role lives on the team_members row, not the key)');
        process.exit(1);
      }

      const rawKey = `cmem_${randomBytes(24).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');

      // Membership and key must land together: a key linked to a user with no
      // team_members row is exactly the roleless state this flag exists to fix.
      let created: Awaited<ReturnType<typeof repo.createApiKey>>;
      if (userId != null) {
        const { PostgresTeamsRepository } = await import('../../storage/postgres/teams.js');
        const { withPostgresTransaction } = await import('../../storage/postgres/pool.js');
        // withPostgresTransaction pins ONE connection for the whole unit of
        // work. Issuing BEGIN/COMMIT via pool.query() would not: a pg Pool may
        // hand each call a different connection, so the statements could land on
        // separate sessions and the "transaction" would not be atomic.
        created = await withPostgresTransaction(pool, async (client) => {
          const teamsRepo = new PostgresTeamsRepository(client);
          await teamsRepo.addMember({
            teamId: teamId!,
            userId,
            role: role as 'owner' | 'admin' | 'member' | 'viewer',
          });
          const { PostgresAuthRepository: TxAuthRepo } = await import('../../storage/postgres/auth.js');
          return await new TxAuthRepo(client).createApiKey({
            keyHash,
            teamId,
            projectId,
            scopes,
            userId,
            actorId: 'system:server-cli',
          });
        });
      } else {
        created = await repo.createApiKey({
          keyHash,
          teamId,
          projectId,
          scopes,
          actorId: 'system:server-cli',
        });
      }

      console.log(JSON.stringify({
        id: created.id,
        key: rawKey,
        name: options.name ?? 'server-api-key',
        teamId,
        projectId,
        scopes,
        ...(userId != null ? { userId, role } : {}),
      }, null, 2));
      return;
    }

    if (sub === 'list') {
      // Bound the result set to prevent unintentional cross-tenant key
      // metadata disclosure when an admin runs `api-key list` on a shared
      // host. Default page is 100; --team filters to a single tenant;
      // --active filters to usable (non-revoked, non-expired) keys.
      const teamFilter = options.team ?? null;
      const limitArg = Number.parseInt(options.limit ?? '100', 10);
      const offsetArg = Number.parseInt(options.offset ?? '0', 10);
      const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= 500
        ? limitArg
        : 100;
      const offset = Number.isFinite(offsetArg) && offsetArg >= 0 ? offsetArg : 0;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options.active) {
        conditions.push('revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())');
      }
      if (teamFilter) {
        params.push(teamFilter);
        conditions.push(`team_id = $${params.length}`);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit, offset);
      // SECURITY: SELECT only non-secret metadata — never key_hash or any
      // raw key material.
      const result = await pool.query<{
        id: string;
        team_id: string | null;
        project_id: string | null;
        scopes: unknown;
        revoked_at: Date | null;
        expires_at: Date | null;
        last_used_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, team_id, project_id, scopes, revoked_at, expires_at, last_used_at, created_at
         FROM api_keys
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      console.log(JSON.stringify({
        teamId: teamFilter,
        limit,
        offset,
        count: result.rows.length,
        keys: result.rows.map(row => ({
          id: row.id,
          teamId: row.team_id,
          projectId: row.project_id,
          scopes: row.scopes,
          status: row.revoked_at ? 'revoked' : 'active',
          lastUsedAt: row.last_used_at?.toISOString() ?? null,
          expiresAt: row.expires_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
      }, null, 2));
      return;
    }

    if (sub === 'revoke') {
      const id = argv[1];
      if (!id) {
        console.error('Usage: server-service server api-key revoke <id>');
        process.exit(1);
      }
      const result = await pool.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [id],
      );
      if (result.rowCount === 0) {
        console.error(`API key not found or already revoked: ${id}`);
        process.exit(1);
      }
      console.log(JSON.stringify({ id, status: 'revoked' }, null, 2));
      return;
    }

    console.error(`Unknown server api-key subcommand: ${sub ?? '(none)'}`);
    console.error('Usage: server-service server api-key create|list|revoke|migrate-scopes');
    process.exit(1);
  } finally {
    // Pool is shared; do not close here. The process will exit and the
    // pool tears down via the shared module's process exit hook.
  }
}

// #2560 — Postgres scope migration. Mirrors migrateServerApiKeyScopes() (the
// SQLite helper) for the server Postgres `api_keys` table: re-issues a
// key's scope set so an operator can bring legacy/empty-scope keys up to a
// working default (or an explicit --scope list). Defaults to the same
// read+write memory scopes the v1 routes require.
const DEFAULT_SERVER_KEY_SCOPES = ['memories:read', 'memories:write'];

export async function migrateServerPostgresApiKeyScopes(argv: string[]): Promise<void> {
  const id = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const options = parseFlagArgs(argv);
  if (!id) {
    console.error('Usage: server-service server api-key migrate-scopes <id> [--scope a,b]');
    process.exit(1);
  }
  const scopes = (options.scope ?? options.scopes ?? DEFAULT_SERVER_KEY_SCOPES.join(','))
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean);

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  const result = await pool.query<{ id: string; scopes: unknown }>(
    `UPDATE api_keys
       SET scopes = $2::jsonb, updated_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id, scopes`,
    [id, JSON.stringify(scopes)],
  );
  if (result.rowCount === 0) {
    console.error(`API key not found or revoked: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ id, scopes, status: 'scopes-migrated' }, null, 2));
}

// #2572 — `server jobs [list|inspect <id>]`: list or inspect queued generation
// jobs from the Postgres `observation_generation_jobs` table the server
// runtime and its BullMQ workers share.
export async function runServerJobsCli(argv: string[]): Promise<void> {
  try {
    assertServerRuntimeForCli('jobs');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const sub = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list').toLowerCase();

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });

  if (sub === 'inspect') {
    const id = argv[1];
    if (!id) {
      console.error('Usage: server-service server jobs inspect <id>');
      process.exit(1);
    }
    const result = await pool.query(
      `SELECT id, project_id, team_id, source_type, source_id, status, attempts,
              max_attempts, created_at, completed_at, failed_at, last_error, payload
         FROM observation_generation_jobs WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      console.error(`Generation job not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result.rows[0], null, 2));
    return;
  }

  // list (default)
  const options = parseFlagArgs(sub === 'list' ? argv.slice(1) : argv);
  const status = options.status ?? null;
  const limitArg = Number.parseInt(options.limit ?? '50', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= 500 ? limitArg : 50;
  const params: unknown[] = [limit];
  let where = '';
  if (status) {
    params.unshift(status);
    where = 'WHERE status = $1';
  }
  const limitIdx = params.length;
  const result = await pool.query<{
    id: string;
    project_id: string;
    team_id: string;
    source_type: string;
    status: string;
    attempts: number;
    created_at: Date;
  }>(
    `SELECT id, project_id, team_id, source_type, status, attempts, created_at
       FROM observation_generation_jobs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx}`,
    params,
  );
  console.log(JSON.stringify({
    status: status ?? 'any',
    count: result.rows.length,
    jobs: result.rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      teamId: row.team_id,
      sourceType: row.source_type,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
    })),
  }, null, 2));
}

interface CliFlagValues {
  scope?: string;
  scopes?: string;
  team?: string;
  project?: string;
  name?: string;
  limit?: string;
  offset?: string;
  status?: string;
  active?: boolean;
  // Role-bearing key mint (`api-key create --user <id> [--role <role>]`).
  // `userId` is the camelCase alias; both spellings are accepted.
  user?: string;
  userId?: string;
  role?: string;
}

function parseFlagArgs(argv: string[]): CliFlagValues {
  return parseArgs({
    args: argv,
    options: {
      scope: { type: 'string' },
      scopes: { type: 'string' },
      team: { type: 'string' },
      project: { type: 'string' },
      name: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      status: { type: 'string' },
      active: { type: 'boolean' },
      user: { type: 'string' },
      userId: { type: 'string' },
      role: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  }).values as CliFlagValues;
}

// Phase 10 — generation-worker-only entrypoint. Starts BullMQ workers against
// the same Postgres + Valkey/Redis the HTTP server service uses, but
// never opens an HTTP listener. In Compose this is a separate, horizontally
// scalable service. The HTTP server service should run with
// MEMSMITH_GENERATION_DISABLED=true so generation only happens in this
// process.
export async function runServerGenerationWorker(): Promise<void> {
  const { validateServerEnv, createServerService } = await import('./create-server-service.js');
  validateServerEnv();
  // Build the service WITHOUT starting HTTP. We reuse createServerService
  // for pool + bootstrap + queue + generation worker wiring, but never call
  // service.start(). Generation is enabled here even if env says
  // MEMSMITH_GENERATION_DISABLED, because this IS the generation worker.
  delete process.env.MEMSMITH_GENERATION_DISABLED;
  const service = await createServerService();
  const state = service.getRuntimeState();
  logger.info('SYSTEM', 'Server generation worker started (no HTTP)', {
    pid: process.pid,
    queue: state.boundaries.queueManager,
    generation: state.boundaries.generationWorkerManager,
  });
  console.log(JSON.stringify({ status: 'worker-running', runtime: SERVER_RUNTIME, pid: process.pid }));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // Block forever — Workers run in background via BullMQ. Without this the
  // process would exit and BullMQ jobs would never be consumed.
  await new Promise<void>(() => {});
}

function getServerPort(): number {
  const parsed = Number.parseInt(process.env.MEMSMITH_SERVER_PORT ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  // UID-derived default for multi-account isolation: two users on the same
  // host get distinct ports without explicit configuration. Containerized
  // deployments always pass MEMSMITH_SERVER_PORT so this branch is local-only.
  return DEFAULT_SERVER_PORT + ((process.getuid?.() ?? 77) % 100);
}

function spawnServerDaemon(port: number): number | undefined {
  const scriptPath = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    // Strip host CLI bleed-through (CLAUDE_CODE_*, including EFFORT_LEVEL) and
    // Anthropic credentials before handing env to the detached daemon. The
    // daemon re-reads credentials from ~/.memsmith/.env at SDK spawn time.
    // See env-isolation discipline (#2357 / #2375).
    env: {
      ...sanitizeEnv(process.env),
      MEMSMITH_SERVER_PORT: String(port),
      MEMSMITH_PROJECT_CWD: process.env.MEMSMITH_PROJECT_CWD ?? process.cwd(),
    },
  });
  child.unref();
  return child.pid;
}

function writeServerState(state: ServerRuntimeState): void {
  mkdirSync(dirname(paths.serverRuntime()), { recursive: true });
  const pidInfo: PidInfo = {
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    startToken: captureProcessStartToken(state.pid) ?? undefined,
  };
  writeFileSync(paths.serverPid(), JSON.stringify(pidInfo, null, 2));
  writeFileSync(paths.serverPort(), `${state.port}\n`);
  writeFileSync(paths.serverRuntime(), JSON.stringify(state, null, 2));
}

function readServerPidFile(): PidInfo | null {
  if (!existsSync(paths.serverPid())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverPid(), 'utf-8')) as PidInfo;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Failed to read server PID file', { path: paths.serverPid() }, err);
    return null;
  }
}

function readServerRuntimeState(): ServerRuntimeState | null {
  if (!existsSync(paths.serverRuntime())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverRuntime(), 'utf-8')) as ServerRuntimeState;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Failed to read server runtime state file', { path: paths.serverRuntime() }, err);
    return null;
  }
}

function removeServerState(): void {
  rmSync(paths.serverPid(), { force: true });
  rmSync(paths.serverPort(), { force: true });
  rmSync(paths.serverRuntime(), { force: true });
}

async function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!verifyPidFileOwnership({ pid, port: 0, startedAt: '' })) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

if (
  process.argv[1]?.endsWith('ServerService.ts') ||
  process.argv[1]?.endsWith('server-service.cjs') ||
  // Plan §1c line 149: keep fallback so installs still booting from the
  // pre-rename plugin cache (server-beta-service.cjs) continue to dispatch.
  process.argv[1]?.endsWith('ServerBetaService.ts') ||
  process.argv[1]?.endsWith('server-beta-service.cjs')
) {
  runServerServiceCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
