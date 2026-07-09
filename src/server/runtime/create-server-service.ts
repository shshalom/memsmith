// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
import { getSharedPostgresPool, SERVER_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerQueueManager } from './ActiveServerQueueManager.js';
import { ActiveServerGenerationWorkerManager } from './ActiveServerGenerationWorkerManager.js';
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
  type ServerGenerationWorkerManager,
  type ServerQueueManager,
  type ServerServiceGraph,
} from './types.js';

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
  const generationDisabled = options.generationDisabled
    ?? (process.env.MEMSMITH_GENERATION_DISABLED === '1'
      || process.env.MEMSMITH_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? new DisabledServerGenerationWorkerManager(
          'MEMSMITH_GENERATION_DISABLED is set; this server runs HTTP only. A separate `memsmith server worker start` process consumes the BullMQ queues.',
        )
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider));
  // Read the local-dev fallback team. Trim + coerce empty string to null so
  // the downstream middleware receives null (no scoping) when the var is unset.
  const localDevTeamId = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim() || null;
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
    queueManager,
    generationWorkerManager,
  };

  if (generationWorkerManager instanceof ActiveServerGenerationWorkerManager) {
    generationWorkerManager.start();
  }

  return new ServerService({ graph });
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerQueueManager)) {
    return new DisabledServerGenerationWorkerManager(
      'queue manager is disabled; set MEMSMITH_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerGenerationWorkerManager(
      'no server generation provider configured; set MEMSMITH_SERVER_PROVIDER and the matching API key to enable.',
    );
  }
  return new ActiveServerGenerationWorkerManager({
    pool,
    queueManager,
    provider,
  });
}

function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {
  const provider = (process.env.MEMSMITH_SERVER_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return null;
  try {
    return instantiateServerGenerationProvider(provider);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Surface the construction failure so operators can see why generation is
    // disabled instead of silently getting a null provider.
    logger.warn('SYSTEM', 'server: failed to construct generation provider from env; generation disabled', { provider }, err);
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
      model: chosenModel ?? 'llama3.1:8b',
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
