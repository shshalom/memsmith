// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject as defaultShouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  logServerFallback as defaultLogServerFallback,
  type ServerRuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

const defaultDependencies = {
  resolveRuntimeContext: defaultResolveRuntimeContext,
  logServerFallback: defaultLogServerFallback,
  shouldTrackProject: defaultShouldTrackProject,
};

let dependencies = defaultDependencies;

export function setSessionInitDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  

    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (!dependencies.shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    if (rawPrompt && isInternalProtocolPayload(rawPrompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: rawPrompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);

    // Non-fatal identity mint: ensure the project has a durable identity + base key
    // in the local embedded PG. Skips silently when the DB is not reachable (e.g.
    // the hook fires before the local runtime is up). Next session-init retries.
    try {
      const { getSharedPostgresPool } = await import('../../storage/postgres/pool.js');
      const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
      const { ensureProjectIdentity, ensureBaseKey } = await import('../../services/identity/project-identity.js');
      const { teamId, projectId: identityProjectId } = await ensureProjectIdentity(pool, cwd);
      await ensureBaseKey(pool, teamId, identityProjectId);
    } catch (err) {
      logger.warn('IDENTITY', 'session-init identity mint skipped (non-fatal)', {}, err instanceof Error ? err : new Error(String(err)));
    }

    const runtime = dependencies.resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. Legacy `'server-beta'` is normalized inside `selectRuntime()`.
    if (runtime.runtime === 'server') {
      try {
        await startServerSession(runtime, input, sessionId, platformSource, project, prompt);
        // Server does not currently support the same context-injection
        // protocol as the worker. Skip semantic injection in server mode
        // until the server context endpoint exists.
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          dependencies.logServerFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/start',
          });
          // fall through to clean skip (worker fallback retired)
        } else {
          logger.error('HOOK', 'Server session-start failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    // No server runtime reachable (embedded not yet available). The worker
    // fallback has been retired; skip cleanly so the hook never blocks.
    logger.debug('HOOK', 'session-init: no reachable runtime; skipping', { sessionId, project });
    return { continue: true, suppressOutput: true };
  }
};

async function startServerSession(
  runtime: ServerRuntimeContext,
  input: NormalizedHookInput,
  sessionId: string,
  platformSource: string,
  project: string,
  prompt: string,
): Promise<void> {
  await runtime.client.startSession({
    projectId: runtime.projectId,
    externalSessionId: sessionId,
    contentSessionId: sessionId,
    agentId: input.agentId ?? null,
    agentType: input.agentType ?? null,
    platformSource,
    metadata: { project, prompt },
  });
  logger.info('HOOK', 'session-init: server session started', {
    contentSessionId: sessionId,
    project,
  });
}

