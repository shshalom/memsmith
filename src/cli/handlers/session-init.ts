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
import { isInternalProtocolPayload, stripMemoryTags } from '../../utils/tag-stripping.js';
import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  logServerFallback as defaultLogServerFallback,
  type ServerRuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';
import { isIncognito, bumpTurn } from '../incognito.js';
import { handleIncognitoCommand } from './incognito-command.js';

const defaultDependencies = {
  resolveRuntimeContext: defaultResolveRuntimeContext,
  logServerFallback: defaultLogServerFallback,
  shouldTrackProject: defaultShouldTrackProject,
};

let dependencies = defaultDependencies;

export function incognitoHeartbeat(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isIncognito(sessionId)) return null;
  const raw = Number.parseInt(env.MEMSMITH_INCOGNITO_REMINDER_TURNS ?? '', 10);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 10;
  const turn = bumpTurn(sessionId);
  return turn % n === 0 ? '🔒 still incognito — not recording' : null;
}

export function setSessionInitDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

export function buildSessionMetadata(project: string, prompt: string): { project: string; prompt: string } {
  return { project, prompt: stripMemoryTags(prompt) };
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

    // /incognito [on|off] — intercept before any other processing so the toggle
    // is always reachable regardless of the tracking or runtime state.
    const trimmedPrompt = (rawPrompt ?? '').trim();
    if (/^\/incognito(\s|$)/i.test(trimmedPrompt) || trimmedPrompt.toLowerCase() === '/incognito') {
      const arg = trimmedPrompt.slice('/incognito'.length).trim() || undefined;
      const { message } = handleIncognitoCommand(sessionId, arg);
      logger.info('HOOK', 'session-init: incognito command handled', { arg, message });
      return {
        continue: true,
        suppressOutput: false,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: message,
        },
      };
    }

    const heartbeat = incognitoHeartbeat(sessionId);
    if (heartbeat) {
      return {
        continue: true,
        suppressOutput: false,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: heartbeat,
        },
      };
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
    //
    // Task 5 (per-project-database routing) — api_keys is an ACCOUNT table
    // that lives ONLY in the base database (a per-project database is
    // bootstrapped with schema mode 'project', which never creates api_keys).
    // getSharedPostgresPool() is the process-wide singleton pool built once
    // from MEMSMITH_SERVER_DATABASE_URL — nothing in this codebase ever
    // constructs it with a per-project connection string, so it always
    // targets the base database. Naming it `baseAccountPool` here (rather
    // than a generic `pool`) makes that invariant explicit at the call site,
    // so key minting can never be accidentally re-pointed at a project DB.
    try {
      // MEMSMITH_SERVER_DATABASE_URL is set by local-runtime via process.env
      // INSIDE the server process and is never written to a file, so this hook
      // — a separate short-lived process — never inherits it. Without this the
      // pool below threw on every session and minting was skipped forever, so a
      // fresh local project came up with no marker, no database, and no memory.
      //
      // The local embedded PG address is a fixed default and a not-yet-existing
      // project needs only the BASE database, so the value is derivable here.
      // A team install always sets the variable explicitly and this is a no-op.
      const { resolveLocalBaseDatabaseUrl } = await import('../../services/identity/local-base-dsn.js');
      process.env.MEMSMITH_SERVER_DATABASE_URL = resolveLocalBaseDatabaseUrl();
      const { getSharedPostgresPool } = await import('../../storage/postgres/pool.js');
      const baseAccountPool = getSharedPostgresPool({ requireDatabaseUrl: true });
      const { ensureProjectIdentity } = await import('../../services/identity/project-identity.js');
      const { CredentialStore } = await import('../../services/identity/credential-store.js');
      // ensureProjectIdentity now guarantees a resolvable base key when given a
      // store (folds in the former separate ensureBaseKey call), so a marker is
      // never written without its key.
      await ensureProjectIdentity(baseAccountPool, cwd, new CredentialStore());
    } catch (err) {
      logger.warn('IDENTITY', 'session-init identity mint skipped (non-fatal)', {}, err instanceof Error ? err : new Error(String(err)));
    }

    // Claim any pending Go Team join left by a convert.
    //
    // The server copies the data but cannot write this project's marker — one
    // shared server can only guess at project directories, and guessing is what
    // let a convert of one project flip another's. So the server leaves a note on
    // the destination database and THIS process — which genuinely runs in the
    // project directory — applies it.
    //
    // Entirely non-fatal: any failure leaves the project on local with its data
    // intact and the note still pending, so the next session retries.
    try {
      const [
        { claimPendingTeamJoin }, { applyConvertJoin },
        { readProjectMarker, writeProjectRuntime }, { CredentialStore },
        { getSharedPostgresPool },
      ] = await Promise.all([
        import('../../server/convert/claim-pending-join.js'),
        import('../../server/convert/apply-join.js'),
        import('../../services/identity/project-identity.js'),
        import('../../services/identity/credential-store.js'),
        import('../../storage/postgres/pool.js'),
      ]);
      const store = new CredentialStore();
      await claimPendingTeamJoin(cwd, {
        readProjectMarker: (c) => readProjectMarker(c) as any,
        resolveKeyForTeam: (teamId) => store.resolveKeyForTeam(teamId),
        // The LOCAL base-account pool, already open above for identity minting.
        // The note lives here, not on the destination: putting it on the remote is
        // circular, since reaching the remote needs the URL the note carries.
        pool: getSharedPostgresPool({ requireDatabaseUrl: true }),
        applyJoin: (c, join) => applyConvertJoin({
          readProjectMarker: (x) => readProjectMarker(x) as any,
          writeProjectRuntime,
          storeKeyForTeam: (teamId, key) => store.storeKeyForTeam(teamId, key),
        }, c, join),
      });
    } catch (err) {
      logger.warn('IDENTITY', 'pending team join not applied (non-fatal)', {}, err instanceof Error ? err : new Error(String(err)));
    }

    const runtime = dependencies.resolveRuntimeContext(cwd);
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
    metadata: buildSessionMetadata(project, prompt),
  });
  logger.info('HOOK', 'session-init: server session started', {
    contentSessionId: sessionId,
    project,
  });
}

