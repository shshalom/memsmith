// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Runtime selector for hook subcommands.
//
// Reads `MEMSMITH_RUNTIME` from `~/.memsmith/settings.json` (via
// `loadFromFileOnce`) and decides whether the hook should call the
// server /v1 endpoints or fall through to the worker compat path.
//
// This module deliberately does not import worker code so that hooks
// running in server mode can reach the runtime even when no worker
// is installed.
//
// Phase 1a (cmem-sdk rename): the canonical runtime value is `'server'`.
// The legacy literal `'server-beta'` is still accepted for back-compat so
// existing settings.json files and `MEMSMITH_RUNTIME` values keep
// working. Likewise, new settings keys `MEMSMITH_SERVER_{URL,API_KEY,
// PROJECT_ID}` are read first and fall back to the legacy
// `MEMSMITH_SERVER_BETA_*` keys when unset.

import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { ServerClient, type ServerClientConfig } from './server-client.js';

export type SelectedRuntime = 'local' | 'server';

export interface ServerRuntimeContext {
  runtime: 'server';
  client: ServerClient;
  projectId: string;
  serverBaseUrl: string;
}

export interface LocalRuntimeContext {
  runtime: 'local';
  // Embedded server not yet reachable (URL/key/project unwritten). Handlers
  // treat this as "skip this hook cleanly" — there is no worker fallback.
  reason: 'server_context_unavailable';
}

export type RuntimeContext = ServerRuntimeContext | LocalRuntimeContext;

export function normalizeRuntime(raw: string | undefined): SelectedRuntime {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'server' || v === 'server-beta') return 'server';
  // Legacy `worker` and anything unset/unknown now resolve to the embedded
  // local runtime (worker retired). Smooth remap: an existing settings.json
  // with MEMSMITH_RUNTIME=worker keeps working, pointed at embedded PG.
  return 'local';
}

export function selectRuntime(): SelectedRuntime {
  const settings = loadFromFileOnce();
  return normalizeRuntime(settings.MEMSMITH_RUNTIME);
}

export function buildServerContext(): ServerRuntimeContext | null {
  const settings = loadFromFileOnce();
  // Phase 1a: read new keys first, fall back to legacy `*_BETA_*` keys so
  // existing settings.json files keep resolving the server runtime.
  // Treat empty string the same as missing — `settings.json` populated from
  // `SettingsDefaults` will write `""` for unset keys, and we want those to
  // fall through to the legacy keys (not short-circuit to empty).
  const pickFirstNonEmpty = (...candidates: Array<string | undefined>): string => {
    for (const c of candidates) {
      const trimmed = (c ?? '').trim();
      if (trimmed.length > 0) return trimmed;
    }
    return '';
  };
  const serverBaseUrl = pickFirstNonEmpty(
    settings.MEMSMITH_SERVER_URL,
    settings.MEMSMITH_SERVER_BETA_URL,
  );
  const apiKey = pickFirstNonEmpty(
    settings.MEMSMITH_SERVER_API_KEY,
    settings.MEMSMITH_SERVER_BETA_API_KEY,
  );
  const projectId = pickFirstNonEmpty(
    settings.MEMSMITH_SERVER_PROJECT_ID,
    settings.MEMSMITH_SERVER_BETA_PROJECT_ID,
  );

  if (!serverBaseUrl) {
    logger.warn('HOOK', '[server-fallback] reason=missing_base_url');
    return null;
  }
  if (!apiKey) {
    logger.warn('HOOK', '[server-fallback] reason=missing_api_key');
    return null;
  }
  if (!projectId) {
    logger.warn('HOOK', '[server-fallback] reason=missing_project_id');
    return null;
  }

  const config: ServerClientConfig = {
    serverBaseUrl,
    apiKey,
  };
  return {
    runtime: 'server',
    client: new ServerClient(config),
    projectId,
    serverBaseUrl,
  };
}

export function resolveRuntimeContext(): RuntimeContext {
  // Both `server` and `local` reach the engine over HTTP; in `local` mode the
  // server runs in-process and MEMSMITH_SERVER_URL points at it. Build a server
  // context for either. If the context can't be built (missing URL/key/project),
  // return a local "skip" context — the worker fallback no longer exists.
  const ctx = buildServerContext();
  if (ctx) return ctx;
  return { runtime: 'local', reason: 'server_context_unavailable' };
}

export function logServerFallback(reason: string, details?: Record<string, unknown>): void {
  logger.warn('HOOK', `[server-fallback] reason=${reason}`, details ?? {});
}
