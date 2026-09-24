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
import { CredentialStore } from '../identity/credential-store.js';
import { readProjectMarker } from '../identity/project-identity.js';
import { projectJoinState } from '../identity/join-state.js';

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

/**
 * Which runtime this project should use.
 *
 * KEY-GATED. A marker saying `runtime: 'server'` is necessary but NOT sufficient:
 * this machine must also hold a key for the marker's team. The marker is a
 * non-secret pointer that ships in the repo while the key lives only in
 * ~/.memsmith, so a freshly cloned team project has the first and not the
 * second — and following the marker alone sent it into server mode with no
 * credential, where buildServerContext logs `missing_api_key` and every
 * observation is silently dropped. On the newly onboarded machine, which is the
 * worst possible place to lose work.
 *
 * This is the read-side half of the invariant applyConvertJoin already enforces
 * on the write side ("flipping without a resolvable key strands the project").
 * A tracked-but-not-joined project captures LOCALLY until its user joins, which
 * is also the product rule: "if identity exists and the user didn't join then
 * the work is offline / local."
 *
 * `hasKeyForTeam` is injectable so tests can classify without touching the
 * developer's real credentials file.
 */
export function selectRuntime(
  cwd: string = process.cwd(),
  hasKeyForTeam: (teamId: string) => boolean = defaultHasKeyForTeam,
): SelectedRuntime {
  const state = projectJoinState(cwd, { readProjectMarker, hasKeyForTeam });
  if (state === 'joined') return 'server';
  // 'tracked' deliberately does NOT consult the global setting: a team project
  // this machine cannot authenticate as must stay local no matter what
  // MEMSMITH_RUNTIME says, or the global default reopens the silent-drop path.
  if (state === 'tracked') return 'local';
  const settings = loadFromFileOnce();
  return normalizeRuntime(settings.MEMSMITH_RUNTIME);
}

/** Real credential lookup. Reads are lock-free and atomic (see CredentialStore). */
function defaultHasKeyForTeam(teamId: string): boolean {
  return Boolean(new CredentialStore().resolveKeyForTeam(teamId));
}

export interface BuildServerContextOptions {
  cwd?: string;
  credentialStore?: CredentialStore;
  // Test seam: override the server base URL instead of reading it from the
  // (process-global, mock-pollutable) settings module. Production callers omit
  // this and the URL resolves from settings as normal.
  serverBaseUrlOverride?: string;
}

export function buildServerContext(options: BuildServerContextOptions = {}): ServerRuntimeContext | null {
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

  // Per-project marker: read from options.cwd (the project cwd passed by the
  // caller). Fall back to the process-level env/cwd only when options.cwd is
  // absent. This ensures per-project resolution uses the RIGHT project's marker.
  const markerCwd = options.cwd ?? process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  const projectMarker = readProjectMarker(markerCwd);

  // Marker serverUrl takes highest precedence (after the explicit test seam
  // override), so a project that has gone team reads/writes ITS team server.
  const serverBaseUrl = pickFirstNonEmpty(
    options.serverBaseUrlOverride,
    projectMarker?.serverUrl,
    settings.MEMSMITH_SERVER_URL,
    settings.MEMSMITH_SERVER_BETA_URL,
  );
  let apiKey = pickFirstNonEmpty(
    settings.MEMSMITH_SERVER_API_KEY,
    settings.MEMSMITH_SERVER_BETA_API_KEY,
  );
  let projectId = pickFirstNonEmpty(
    settings.MEMSMITH_SERVER_PROJECT_ID,
    settings.MEMSMITH_SERVER_BETA_PROJECT_ID,
  );

  if (!serverBaseUrl) {
    logger.warn('HOOK', '[server-fallback] reason=missing_base_url');
    return null;
  }

  // Local-identity / per-project path: when no explicit team-mode key is
  // configured in global settings, resolve the project's key from the marker +
  // CredentialStore (the key-everywhere seam). When a project marker exists,
  // its teamId drives the key lookup — this is what makes per-project team
  // mode work (each project reads its own team's key). Also covers the
  // local-injection + MCP recall path for non-team projects.
  if (!apiKey) {
    if (projectMarker) {
      const store = options.credentialStore ?? new CredentialStore();
      const resolved = store.resolveKeyForTeam(projectMarker.teamId);
      if (resolved) {
        apiKey = resolved;
        if (!projectId) projectId = projectMarker.projectId;
      }
    }
  }

  if (!apiKey) {
    logger.warn('HOOK', '[server-fallback] reason=missing_api_key');
    return null;
  }
  if (!projectId) {
    logger.warn('HOOK', '[server-fallback] reason=missing_project_id');
    return null;
  }

  // Team mode ('server' runtime): generation runs on this machine (local
  // generation), so events must be recorded WITHOUT enqueuing server-side
  // generation. Set centrally here rather than at each recordEvent call
  // site, so a new call site inherits the correct behavior automatically.
  const config: ServerClientConfig = {
    serverBaseUrl,
    apiKey,
    delegateGeneration: selectRuntime(markerCwd) === 'server',
  };
  return {
    runtime: 'server',
    client: new ServerClient(config),
    projectId,
    serverBaseUrl,
  };
}

export function resolveRuntimeContext(cwd?: string): RuntimeContext {
  // Both `server` and `local` reach the engine over HTTP; in `local` mode the
  // server runs in-process and MEMSMITH_SERVER_URL points at it. Build a server
  // context for either. If the context can't be built (missing URL/key/project),
  // return a local "skip" context — the worker fallback no longer exists.
  // The optional `cwd` is forwarded to buildServerContext so per-project marker
  // resolution uses the RIGHT project (not process.cwd()).
  const ctx = buildServerContext(cwd !== undefined ? { cwd } : {});
  if (ctx) return ctx;
  return { runtime: 'local', reason: 'server_context_unavailable' };
}

export function logServerFallback(reason: string, details?: Record<string, unknown>): void {
  logger.warn('HOOK', `[server-fallback] reason=${reason}`, details ?? {});
}
