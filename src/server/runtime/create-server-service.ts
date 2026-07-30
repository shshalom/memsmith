// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
import { getSharedPostgresPool, SERVER_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerPostgresSchema } from '../../storage/postgres/schema.js';
import { createPostgresPool, type PostgresPool } from '../../storage/postgres/pool.js';
import { PoolRegistry } from '../../storage/postgres/pool-registry.js';
import { parsePostgresConfig } from '../../storage/postgres/config.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerQueueManager } from './ActiveServerQueueManager.js';
import { ActiveServerGenerationWorkerManager } from './ActiveServerGenerationWorkerManager.js';
import {
  loadQueuedJobsForDrain, reclaimStaleLocks, requeueDrainedJobs, resolveQueueConcurrency,
} from './generation-drain.js';
import { InlineServerQueueManager } from './InlineServerQueueManager.js';
import { ClaudeObservationProvider } from '../generation/providers/ClaudeObservationProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OllamaObservationProvider } from '../generation/providers/OllamaObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
export type { ServerGenerationProvider };
import { ServerService } from './ServerService.js';
import {
  DisabledServerGenerationWorkerManager,
  DisabledServerQueueManager,
  type ServerAuthMode,
  type ServerBootstrapStatus,
  type ServerGenerationQueueManager,
  type ServerGenerationWorkerManager,
  type ServerQueueManager,
  type ServerServiceGraph,
} from './types.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { SettingsResolver } from '../settings/SettingsResolver.js';
import { GenerationProviderHolder } from '../generation/GenerationProviderHolder.js';
import { readLocalScopeFromMarkerOrEnv } from './resolve-local-scope.js';
import { resolveGenerationProviderName } from './resolve-generation-provider.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';

export interface CreateServerServiceOptions {
  pool?: PostgresPool;
  authMode?: ServerAuthMode;
  bootstrapSchema?: boolean;
  queueManager?: ServerQueueManager;
  // Phase 5 seam: tests can inject a fake provider without env config.
  generationProvider?: ServerGenerationProvider;
  generationWorkerManager?: ServerGenerationWorkerManager;
  // Phase 10: when true, skip building the generation worker. Used when the
  // service is just an HTTP front-end and a separate `server worker` process
  // consumes the BullMQ queues.
  generationDisabled?: boolean;
  // Phase 10: skip env validation (tests). Production code paths always run
  // validation so misconfiguration fails fast at startup.
  skipEnvValidation?: boolean;
}

// Phase 10 — env validation. Server in Docker requires explicit, complete
// configuration. Missing pieces fail fast at startup rather than silently
// degrading. Required env when running in Docker:
//   - MEMSMITH_SERVER_DATABASE_URL  (Postgres)
//   - MEMSMITH_QUEUE_ENGINE=bullmq  (no in-memory queue in Docker)
//   - MEMSMITH_REDIS_URL            (BullMQ requires Redis/Valkey)
//   - MEMSMITH_AUTH_MODE != local-dev (auth must be real in Docker)
// `local-dev` bypass is only valid on a developer's loopback; in Docker the
// container is reachable via service-to-service networking and exposed ports,
// so the loopback assumption is invalid.
export interface ServerEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  isDocker?: boolean;
}

export interface ServerEnvValidationResult {
  isDocker: boolean;
  runtime: string;
  authMode: string;
  queueEngine: string;
  hasDatabaseUrl: boolean;
  hasRedisUrl: boolean;
}

export function detectDockerEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MEMSMITH_DOCKER === '1' || env.MEMSMITH_DOCKER === 'true') return true;
  // /.dockerenv is the canonical Docker marker; existsSync is cheap.
  try {
    if (existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  return false;
}

export function validateServerEnv(
  options: ServerEnvValidationOptions = {},
): ServerEnvValidationResult {
  const env = options.env ?? process.env;
  const isDocker = options.isDocker ?? detectDockerEnvironment(env);
  const errors: string[] = [];

  const runtime = (env.MEMSMITH_RUNTIME ?? '').trim();
  if (!runtime) {
    // Warn but allow — defaulted to 'worker' upstream; we log a warning so
    // operators know the server runtime is active here.
    if (isDocker) {
      logger.warn('SYSTEM', 'MEMSMITH_RUNTIME unset; server container assumes runtime=server');
    }
  } else if (runtime !== 'server' && runtime !== 'server-beta' && isDocker) {
    // Phase 1a (cmem-sdk rename): accept both the canonical `server` and the
    // legacy `server-beta` literal so existing operator configs keep working.
    errors.push(
      `MEMSMITH_RUNTIME=${runtime} is invalid in Docker; the server image only runs MEMSMITH_RUNTIME=server (or legacy MEMSMITH_RUNTIME=server-beta).`,
    );
  }

  const authMode = (env.MEMSMITH_AUTH_MODE ?? 'api-key').trim();
  if (isDocker) {
    if (authMode === 'local-dev') {
      errors.push(
        'MEMSMITH_AUTH_MODE=local-dev is not allowed in Docker. Set MEMSMITH_AUTH_MODE=api-key and create a key with `memsmith server api-key create`.',
      );
    }
    if (
      env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS === '1'
      || env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS === 'true'
    ) {
      errors.push(
        'MEMSMITH_ALLOW_LOCAL_DEV_BYPASS is not allowed in Docker. Loopback bypass cannot be enforced inside a container; remove the variable.',
      );
    }
  }

  const queueEngine = (env.MEMSMITH_QUEUE_ENGINE ?? '').trim().toLowerCase();
  if (isDocker) {
    if (!queueEngine) {
      errors.push('MEMSMITH_QUEUE_ENGINE is required in Docker; set it to "bullmq".');
    } else if (queueEngine !== 'bullmq') {
      errors.push(
        `MEMSMITH_QUEUE_ENGINE=${queueEngine} is not allowed in Docker. Only "bullmq" is supported (no in-process queues across container boundaries).`,
      );
    }
  }

  const hasDatabaseUrl = Boolean((env.MEMSMITH_SERVER_DATABASE_URL ?? '').trim());
  if (!hasDatabaseUrl) {
    errors.push('MEMSMITH_SERVER_DATABASE_URL is required to start the server (Postgres connection string).');
  }

  const hasRedisUrl = Boolean((env.MEMSMITH_REDIS_URL ?? '').trim());
  if (queueEngine === 'bullmq' && !hasRedisUrl) {
    errors.push('MEMSMITH_REDIS_URL is required when MEMSMITH_QUEUE_ENGINE=bullmq.');
  }

  if (errors.length > 0) {
    const message = [
      'server startup configuration is invalid:',
      ...errors.map(line => `  - ${line}`),
    ].join('\n');
    throw new Error(message);
  }

  return {
    isDocker,
    // Phase 1a: report the canonical `'server'` value when unset; legacy
    // `'server-beta'` is preserved verbatim when explicitly supplied so
    // diagnostics reflect the operator's actual config.
    runtime: runtime || 'server',
    authMode,
    queueEngine: queueEngine || 'disabled',
    hasDatabaseUrl,
    hasRedisUrl,
  };
}

// #2443 — the server runtime must load an observation mode before it can
// process any generation job; without it every job fails with "No mode
// loaded". We mirror the worker's pattern (src/services/worker-service.ts) and
// fail fast at boot if no mode can be loaded, so a broken install surfaces at
// startup rather than as silent per-job failures.
export function loadServerMode(): void {
  // ModeManager.loadMode('code') throws ('Critical: code.json mode file
  // missing') if the bundled mode is absent — that propagates as a fatal boot
  // error. We additionally assert a mode is active afterward.
  const modeManager = ModeManager.getInstance();
  modeManager.loadMode('code');
  // getActiveMode() throws if nothing is loaded — this is the explicit
  // validation that boot did not silently no-op.
  modeManager.getActiveMode();
  logger.info('SYSTEM', 'Server mode loaded', { mode: 'code' });
}

export async function createServerService(
  options: CreateServerServiceOptions = {},
): Promise<ServerService> {
  if (!options.skipEnvValidation) {
    validateServerEnv();
  }
  // Fail fast if no observation mode can be loaded (#2443). Must happen before
  // the service starts accepting jobs.
  loadServerMode();
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  // Read the local-dev fallback team/project: env > marker (no minting here —
  // the runtime boot in defaultRunImport already minted, so the marker exists).
  const _localScope = readLocalScopeFromMarkerOrEnv(process.env.MEMSMITH_PROJECT_CWD ?? process.cwd());
  const localDevTeamId = _localScope?.teamId ?? null;
  const localDevProjectId = _localScope?.projectId ?? null;
  // Per-request database routing (per-project-database design). The registry
  // is only buildable when we can resolve a real base connection string (i.e.
  // MEMSMITH_SERVER_DATABASE_URL is set) — options.pool can be injected by
  // tests/tools without that env var, in which case per-request routing is
  // simply not wired and every route keeps using the base pool directly (see
  // the `poolRegistry?` fallback documented on ServerServiceGraph).
  //
  // Built BEFORE the generation worker manager (Critical 1 fix) so the
  // registry + base-project mapping can be threaded into
  // ActiveServerGenerationWorkerManager / ProviderObservationGenerator,
  // giving the generation path the same per-job routing the HTTP path
  // already has via resolveRequestDatabase.
  const poolRegistry = buildPoolRegistry(pool);
  const generationDisabled = options.generationDisabled
    ?? (process.env.MEMSMITH_GENERATION_DISABLED === '1'
      || process.env.MEMSMITH_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? new DisabledServerGenerationWorkerManager(
          'MEMSMITH_GENERATION_DISABLED is set; this server runs HTTP only. A separate `memsmith server worker start` process consumes the BullMQ queues.',
        )
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider, poolRegistry, localDevProjectId));
  const graph: ServerServiceGraph = {
    // Persisted runtime literal — Phase 1d will migrate this value. The TS
    // identifiers above are now `Server*`; the wire/storage value remains
    // `'server-beta'` for back-compat.
    runtime: 'server-beta',
    postgres: {
      pool,
      bootstrap,
    },
    authMode: options.authMode ?? parseAuthMode(process.env.MEMSMITH_AUTH_MODE),
    localDevTeamId,
    localDevProjectId,
    queueManager,
    generationWorkerManager,
    ...(poolRegistry
      ? { poolRegistry: poolRegistry.registry, baseDatabaseName: poolRegistry.baseDatabaseName, baseProjectId: localDevProjectId }
      : {}),
  };

  if (generationWorkerManager instanceof ActiveServerGenerationWorkerManager) {
    generationWorkerManager.start();
    // Recover jobs abandoned by a previous process.
    //
    // The inline queue's work list is in-memory only, populated solely by add()
    // at enqueue time — so every restart left its queued rows stranded in
    // Postgres with nothing to pick them up. On the dogfood that reached 6,958
    // jobs spanning two weeks: all the activity captured, none of it distilled,
    // and no warning anywhere. Nothing was lost (the agent_events survive and
    // each job still carries its agent_event_id), which is precisely why
    // replaying them recovers the lot.
    //
    // Fire-and-forget: a drain failure must never block startup. Both helpers
    // swallow their own errors, so the catch is belt-and-braces.
    void (async () => {
      // Reclaim first: a job locked by a process that died stays 'processing'
      // forever and the drain below cannot see it. Returning those to 'queued'
      // means one pass recovers both kinds of stranded work.
      const reclaimed = await reclaimStaleLocks(pool);
      if (reclaimed > 0) {
        logger.info('SYSTEM', 'reclaimed stale generation locks', { reclaimed });
      }
      const jobs = await loadQueuedJobsForDrain(pool);
      if (jobs.length === 0) return;
      const result = await requeueDrainedJobs(jobs, {
        resolveQueue: (kind: 'event' | 'summary') => {
          const mgr = queueManager as { getQueue?: (k: string) => { add: (id: string, p: unknown) => Promise<void> } };
          try { return mgr.getQueue ? mgr.getQueue(kind) : null; } catch { return null; }
        },
      });
      // Log it: the entire failure mode here was silence — 6,958 jobs stranded
      // for two weeks with nothing reporting it.
      logger.info('SYSTEM', 'generation backlog drain', {
        found: jobs.length, requeued: result.requeued, skipped: result.skipped,
      });
    })().catch(() => { /* never blocks boot */ });
  }

  return new ServerService({ graph });
}

// Builds the PoolRegistry used for per-request database routing. Returns null
// when MEMSMITH_SERVER_DATABASE_URL is unset (e.g. a test injected a fake pool
// directly) — in that case per-request routing is not wired at all and every
// route keeps using the base pool, matching pre-Task-5 behavior exactly.
function buildPoolRegistry(
  basePool: PostgresPool,
): { registry: PoolRegistry; baseDatabaseName: string } | null {
  const config = parsePostgresConfig({ requireDatabaseUrl: false });
  if (!config) return null;
  let baseDatabaseName: string;
  try {
    baseDatabaseName = new URL(config.connectionString).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
  if (!baseDatabaseName) return null;

  // The admin/maintenance connection targets the BASE database (never a
  // per-project database) — CREATE DATABASE and pg_database lookups must run
  // against it. Reuses the base pool itself; it already targets baseDatabaseName.
  const adminQuery = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const result = await basePool.query(text, params);
    return { rows: result.rows };
  };

  const registry = new PoolRegistry({
    baseConnectionString: config.connectionString,
    basePool,
    baseDatabaseName,
    createPool: (connectionString: string) => createPostgresPool({ ...config, connectionString }),
    adminQuery,
    bootstrapProject: (p) => bootstrapServerPostgresSchema(p, 'project'),
    seedHinge,
  });
  return { registry, baseDatabaseName };
}

// Task 5 carryover from the Task 4 review: seed the new project database's
// own hinge rows (teams/projects) so the data tables' FKs (observations.team_id
// -> teams.id, observations.project_id -> projects.id) resolve on first write.
// Mirrors the existing seeding in local-runtime.ts (defaultRunImport).
export async function seedHinge(
  pool: PostgresPool,
  ids: { teamId: string; projectId: string },
): Promise<void> {
  // Guard: the Task 4 middleware coalesces teamId ?? '' (advisory-only for
  // routing), which is inert until this function runs. An empty/blank teamId
  // here would silently insert a `teams` row with id='' — a project DB
  // without a valid team anchor is a bug, not a value to persist quietly.
  if (!ids.teamId || !ids.teamId.trim()) {
    throw new Error(
      `seedHinge: refusing to seed hinge rows with an empty teamId (projectId=${ids.projectId}). ` +
        'A project database requires a valid team anchor.',
    );
  }
  await pool.query('INSERT INTO teams (id, name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [ids.teamId]);
  await pool.query(
    'INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [ids.projectId, ids.teamId],
  );
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerQueueManager,
  injectedProvider?: ServerGenerationProvider,
  poolRegistryResult?: { registry: PoolRegistry; baseDatabaseName: string } | null,
  baseProjectId?: string | null,
): ServerGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerQueueManager) && !(queueManager instanceof InlineServerQueueManager)) {
    return new DisabledServerGenerationWorkerManager(
      'queue manager is disabled; set MEMSMITH_QUEUE_ENGINE=bullmq or inline to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerGenerationWorkerManager(
      'no server generation provider configured; set MEMSMITH_SERVER_PROVIDER and the matching API key to enable.',
    );
  }
  // Task 9: build a SettingsResolver + GenerationProviderHolder so each
  // generation job can resolve its (provider, model) at job-start, enabling
  // live Ollama<->Claude hot-swap without a worker restart. The env-built
  // `provider` is kept as the fallback for when the holder returns null.
  const settingsStore = new SettingsStore(pool);
  const resolver = new SettingsResolver(settingsStore);
  const providerHolder = new GenerationProviderHolder(resolver);
  return new ActiveServerGenerationWorkerManager({
    pool,
    // Cast is safe: queueManager is guarded by the instanceof check above,
    // so only ActiveServerQueueManager or InlineServerQueueManager reach here —
    // both satisfy ServerGenerationQueueManager.
    queueManager: queueManager as ServerGenerationQueueManager,
    provider,
    providerHolder,
    // Task 13: pass the same resolver so quality knobs (qualityFloor,
    // reformatRetries) honor team overrides in the generation pipeline.
    settingsResolver: resolver,
    // Critical 1 fix — thread per-job database routing through so generated
    // observations for a non-base project land in THAT project's database,
    // not the base pool. Absent when MEMSMITH_SERVER_DATABASE_URL isn't set
    // (tests/injected pools) — see buildPoolRegistry's own back-compat note.
    ...(poolRegistryResult ? { poolRegistry: poolRegistryResult.registry } : {}),
    baseProjectId: baseProjectId ?? null,
  });
}

/** settings.json values are `unknown`; treat blank as absent so a `""` never wins. */
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {
  // Resolve env > settings.json > registry default ('ollama'). Reading only
  // process.env meant the declared default never applied on a real install —
  // MemSmith's settings live in ~/.memsmith/settings.json — so a fresh local
  // project generated nothing and its jobs queued forever.
  let fileSettings: Record<string, unknown> = {};
  try {
    fileSettings = loadFromFileOnce() as unknown as Record<string, unknown>;
  } catch { /* defaults still apply if settings are unreadable */ }

  const provider = resolveGenerationProviderName(process.env, fileSettings);
  if (!provider) {
    logger.warn('SYSTEM', 'server: MEMSMITH_SERVER_PROVIDER is not a known provider; generation disabled', {
      configured: (process.env.MEMSMITH_SERVER_PROVIDER ?? fileSettings.MEMSMITH_SERVER_PROVIDER ?? '') as string,
    });
    return null;
  }
  // Resolve the MODEL from settings too, not just the provider.
  //
  // instantiateServerGenerationProvider reads only process.env.MEMSMITH_SERVER_MODEL
  // and otherwise falls back to a hardcoded per-provider default — for ollama
  // that is llama3.1:8b, which produces materially worse observations (vague
  // restatements, invented rationale) than the configured qwen2.5:14b. Ollama's
  // model lives under its own key (MEMSMITH_OLLAMA_MODEL), which nothing here
  // ever read, so the right model only arrived when some other path happened to
  // export it into process.env first.
  //
  // Same settings-vs-env shape as the provider bug above: configured in one
  // place, read from another, hardcoded default silently winning.
  const modelFromSettings = provider === 'ollama'
    ? (process.env.MEMSMITH_OLLAMA_MODEL
        ?? asNonEmptyString(fileSettings.MEMSMITH_OLLAMA_MODEL)
        ?? asNonEmptyString(fileSettings.MEMSMITH_SERVER_MODEL))
    : (process.env.MEMSMITH_SERVER_MODEL ?? asNonEmptyString(fileSettings.MEMSMITH_SERVER_MODEL));

  try {
    return instantiateServerGenerationProvider(provider, modelFromSettings);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Surface the construction failure so operators can see why generation is
    // disabled instead of silently getting a null provider.
    logger.warn('SYSTEM', 'server: failed to construct generation provider; generation disabled', { provider }, err);
    return null;
  }
}

export function instantiateServerGenerationProvider(
  provider: string,
  model?: string,
): ServerGenerationProvider | null {
  const chosenModel = model ?? process.env.MEMSMITH_SERVER_MODEL;
  if (provider === 'claude' || provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.MEMSMITH_ANTHROPIC_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    return new ClaudeObservationProvider(opts);
  }
  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.MEMSMITH_GEMINI_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    return new GeminiObservationProvider(opts);
  }
  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.MEMSMITH_OPENROUTER_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string; baseUrl?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL.
    const baseUrl = process.env.MEMSMITH_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OpenRouterObservationProvider(opts);
  }
  if (provider === 'ollama') {
    // Keyless by default — do NOT gate on an API key. A key is only used when
    // Ollama is fronted by an auth proxy.
    const apiKey = process.env.MEMSMITH_OLLAMA_API_KEY ?? '';
    const opts: { apiKey?: string; model?: string; baseUrl?: string } = {
      // qwen2.5:14b, matching the registry default. This was 'llama3.1:8b',
      // which produces materially worse observations (vague restatements,
      // invented rationale — measured 2.86 vs 3.90). Callers now pass the
      // configured model, so this last-resort fallback should rarely fire; when
      // it does it must not silently downgrade the quality of stored memory.
      model: chosenModel ?? 'qwen2.5:14b',
    };
    if (apiKey) opts.apiKey = apiKey;
    const baseUrl = process.env.MEMSMITH_OLLAMA_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OllamaObservationProvider(opts);
  }
  return null;
}

// Queue manager selection is fail-fast on misconfiguration. If the user
// explicitly opts into BullMQ via MEMSMITH_QUEUE_ENGINE=bullmq we build
// the active manager; any error there throws so the runtime does not
// silently fall back to a disabled queue. Default behavior (sqlite engine
// or no opt-in) keeps the disabled boundary so worker-era runtimes stay
// compatible.
function buildQueueManager(): ServerQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine === 'inline') {
    return new InlineServerQueueManager(resolveQueueConcurrency(process.env));
  }
  if (config.engine !== 'bullmq') {
    return new DisabledServerQueueManager(
      `Queue engine is "${config.engine}"; set MEMSMITH_QUEUE_ENGINE=bullmq to activate the server queue manager.`,
    );
  }
  return new ActiveServerQueueManager(config);
}

async function initializePostgres(pool: PostgresPool, bootstrapSchema: boolean): Promise<ServerBootstrapStatus> {
  if (!bootstrapSchema) {
    return { initialized: false, schemaVersion: null, appliedAt: null };
  }

  await bootstrapServerPostgresSchema(pool);
  const result = await pool.query(
    `
      SELECT version, applied_at
      FROM server_beta_schema_migrations
      WHERE version = $1
    `,
    [SERVER_POSTGRES_SCHEMA_VERSION],
  );
  const row = result.rows[0] as { version?: number; applied_at?: Date | string } | undefined;

  return {
    initialized: row?.version === SERVER_POSTGRES_SCHEMA_VERSION,
    schemaVersion: typeof row?.version === 'number' ? row.version : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

function parseAuthMode(value: string | undefined): ServerAuthMode {
  if (value === 'local-dev' || value === 'disabled') {
    return value;
  }
  return 'api-key';
}
