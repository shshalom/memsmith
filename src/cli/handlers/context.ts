// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { appendTeamMemoryInjection } from '../../server/retrieval/inject-append.js';
import { buildInjectionBlock } from '../../server/retrieval/inject.js';
import { fetchTeamMemory } from '../../server/retrieval/team-inject-client.js';
import { getProjectContext as defaultGetProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce as defaultLoadFromFileOnce } from '../../shared/hook-settings.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { callMcpToolOnce } from '../../shared/mcp-client.js';
import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  type RuntimeContext,
} from '../../services/hooks/runtime-selector.js';
import { resolveDashboardUrl } from '../../shared/dashboard-url.js';
import { INJECTED_DIRECTIVES } from '../../services/retrieval/directive.js';

// The SessionStart primary-context budget. Injection is NOT query-driven at
// startup — we pull the most recent observations for the project scope and pack
// them into a string the same way POST /v1/context does server-side.
const SESSION_START_RECENT_LIMIT = 10;

/**
 * How many observations SessionStart injects, from MEMSMITH_CONTEXT_SESSION_COUNT.
 *
 * This was hardcoded at 10 while a control for it sat in Settings doing nothing:
 * the Context pane rendered MEMSMITH_CONTEXT_SESSION_COUNT and saved it, but its
 * only reader was the worker's context-generator, deleted with the worker. So the
 * user could set the value, see it persist, and have it change nothing — a
 * setting and a hardcoded constant describing the same quantity, disagreeing in
 * silence.
 *
 * Clamped rather than trusted: a 0 would inject nothing (memory silently
 * disabled), and a very large value would blow the session-start budget on a
 * corpus of thousands. Both are worse failures than ignoring a bad input.
 */
const MIN_SESSION_OBSERVATIONS = 1;
const MAX_SESSION_OBSERVATIONS = 50;

export function resolveSessionStartLimit(raw: string | undefined | null): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return SESSION_START_RECENT_LIMIT;
  if (parsed < MIN_SESSION_OBSERVATIONS) return MIN_SESSION_OBSERVATIONS;
  if (parsed > MAX_SESSION_OBSERVATIONS) return MAX_SESSION_OBSERVATIONS;
  return parsed;
}

/**
 * Mint this project's identity so the dashboard link can be scoped.
 *
 * Injectable because it WRITES: a successful mint inserts a `projects` row into
 * the live local Postgres. A test exercising the degrade path ("identity cannot
 * be minted") had no way to prevent that, so on any developer machine running
 * the dogfood server the mint quietly succeeded and left a row behind — 31 of
 * them accumulated, one per full-suite run, and surfaced in the user's real
 * project switcher.
 *
 * Overriding the env DSN is not a fix: resolveLocalBaseDatabaseUrl reads
 * process.env at call time, and other suites mutate the same variable, so the
 * outcome depends on file ordering. The seam has to be the mint itself.
 */
async function defaultMintProjectIdentity(cwd: string): Promise<{ teamId: string; projectId: string } | null> {
  const { ensureProjectIdentityForHook, realEnsureIdentityDeps } =
    await import('./ensure-identity.js');
  return ensureProjectIdentityForHook(cwd, await realEnsureIdentityDeps());
}

const defaultDependencies = {
  resolveRuntimeContext: defaultResolveRuntimeContext,
  getProjectContext: defaultGetProjectContext,
  loadFromFileOnce: defaultLoadFromFileOnce,
  mintProjectIdentity: defaultMintProjectIdentity,
};

let dependencies = defaultDependencies;

export function setContextDependenciesForTesting(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides };
}

// C1 (worker retirement) — restore primary SessionStart / UserPromptSubmit
// injection. The worker route `/api/context/inject` that used to serve this was
// deleted, so this pulls recent project context off the SAME server/local
// runtime the capture handlers use (resolveRuntimeContext + ServerClient).
//
// Injection is NOT query-driven at SessionStart: we request the most recent
// observations for the project scope via the server's empty-query "list recent"
// mode (POST /v1/search with query='') and pack their content into a string the
// same way POST /v1/context does (`content.join('\n\n')`). This preserves the
// old "recent + relevant project context, injected as a string" behavior and
// the plain-string handler contract (additionalContext = <string>).
//
// Graceful-empty contract: returns '' (never throws, never blocks the session)
// when no server runtime is reachable or no observations exist — but it MUST be
// non-empty when observations DO exist for the project.
async function fetchPrimaryInjection(
  runtime: RuntimeContext,
  args: { projectId: string; platformSource?: string; limit?: number },
): Promise<string> {
  if (runtime.runtime !== 'server') {
    // No server context reachable (embedded PG not yet available). Skip cleanly.
    return '';
  }
  try {
    const response = await runtime.client.searchObservations({
      projectId: args.projectId,
      query: '', // empty query = "list recent" (ServerV1PostgresRoutes /v1/search)
      limit: args.limit ?? SESSION_START_RECENT_LIMIT,
      ...(args.platformSource !== undefined ? { platformSource: args.platformSource } : {}),
    });
    const observations = Array.isArray(response?.observations) ? response.observations : [];
    // Same context-packing rule as POST /v1/context: join non-empty contents.
    return observations
      .map(observation => observation.content)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  } catch (error: unknown) {
    // Injection must never break the session — log and inject empty.
    logger.warn('HOOK', 'primary context injection failed; continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

async function requestSessionStartContext(args: {
  projects: string[];
  platformSource?: string;
  colors?: boolean;
}): Promise<string | null> {
  const result = await callMcpToolOnce('session_start_context', {
    projects: args.projects,
    ...(args.platformSource ? { platformSource: args.platformSource } : {}),
    ...(args.colors !== undefined ? { colors: args.colors } : {}),
  });
  if (result.isError) {
    logger.warn('HOOK', 'MCP session_start_context returned an error; falling back to direct runtime injection', {
      preview: result.text.slice(0, 200),
    });
    return null;
  }
  return result.text.trim();
}

async function fetchSessionStartContextViaMcp(args: {
  projects: string[];
  platformSource?: string;
  colors?: boolean;
}): Promise<string | null> {
  try {
    return await requestSessionStartContext(args);
  } catch (error: unknown) {
    logger.warn('HOOK', 'MCP session_start_context failed; falling back to direct runtime injection', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = dependencies.getProjectContext(cwd);

    const settings = dependencies.loadFromFileOnce();
    const showTerminalOutput = settings.MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    const normalizedPlatformSource = input.platform
      ? normalizePlatformSource(input.platform)
      : undefined;

    let additionalContext: string;
    const mcpContextResult = input.platform === 'codex'
      ? await fetchSessionStartContextViaMcp({
          projects: context.allProjects,
          ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
        })
      : null;

    if (mcpContextResult !== null) {
      additionalContext = mcpContextResult;
    } else {
      // C1 — primary injection now runs off the server/local runtime (the worker
      // route that served it was retired). Recent-mode (empty query), packed the
      // same way POST /v1/context packs its context string.
      const runtime = dependencies.resolveRuntimeContext();
      additionalContext = (await fetchPrimaryInjection(runtime, {
        projectId: context.primary,
        // Honour MEMSMITH_CONTEXT_SESSION_COUNT. `settings` is already loaded
        // above for showTerminalOutput, so this costs nothing.
        limit: resolveSessionStartLimit(settings.MEMSMITH_CONTEXT_SESSION_COUNT),
        ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
      })).trim();
    }

    // Issue #2215: surface stale OAuth token marker as a session-start hint.
    // Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
    // a previous worker spawn detected an expired keychain entry.
    const staleReason = readStaleMarker();
    if (staleReason) {
      const hint = `[memsmith] Claude Desktop OAuth token is stale: ${staleReason}\nPlease re-login via Claude Desktop to refresh the token.`;
      additionalContext = additionalContext
        ? `${hint}\n\n${additionalContext}`
        : hint;
    }

    // Always surface the dashboard link at session start — even on an empty
    // project (buildInjectionBlock returns '' with no memory, but the link is
    // most useful exactly then). resolveDashboardUrl is pure/total.
    // Scope the link to THIS project. One server serves every local project,
    // so a bare link lands on whichever project the server booted from — which
    // also means the Go Team wizard would act on that project rather than this
    // one. Best-effort: an unreadable marker just yields the unscoped link.
    //
    // Mint the identity here if it does not exist yet. It used to be minted only
    // by sessionInitHandler, which runs on UserPromptSubmit — i.e. on the user's
    // FIRST MESSAGE, strictly after this line. So on the first session of a new
    // project the marker did not exist and the link came out unscoped; only the
    // second session showed the right one. The fallback below treated that as an
    // edge case, but on a fresh project it was the certain case.
    //
    // ensureProjectIdentityForHook is idempotent and never throws, so calling it
    // on every session start is safe and an existing project pays only a marker
    // read.
    let dashboardProjectId: string | undefined;
    try {
      const { readProjectMarker } = await import('../../services/identity/project-identity.js');
      dashboardProjectId = readProjectMarker(cwd)?.projectId;
      if (!dashboardProjectId) {
        const minted = await dependencies.mintProjectIdentity(cwd);
        dashboardProjectId = minted?.projectId;
      }
    } catch { /* unscoped link is a fine fallback */ }
    const dashboardLine = `📊 MemSmith dashboard: ${resolveDashboardUrl(dashboardProjectId)}`;
    additionalContext = additionalContext
      ? `${dashboardLine}\n\n${additionalContext}`
      : dashboardLine;

    // RECOGNISE a team project this machine has not joined.
    //
    // This lives on SessionStart rather than in the installer because that is
    // the only place that behaves identically no matter how MemSmith arrived.
    // The first version sat in `npx memsmith install`; real users install via
    // Claude Code's `/plugin`, which never calls it, so a teammate cloning a
    // converted project was told nothing at all.
    //
    // Silent unless actionable, and never throws: a failure to classify must
    // not cost the user their session context, which is what this hook exists
    // to deliver.
    try {
      const [{ projectJoinState }, { readProjectMarker }, { CredentialStore }, { trackedProjectBanner }] =
        await Promise.all([
          import('../../services/identity/join-state.js'),
          import('../../services/identity/project-identity.js'),
          import('../../services/identity/credential-store.js'),
          import('./tracked-project-banner.js'),
        ]);
      const store = new CredentialStore();
      const banner = trackedProjectBanner({
        state: projectJoinState(cwd, {
          readProjectMarker,
          hasKeyForTeam: (teamId: string) => Boolean(store.resolveKeyForTeam(teamId)),
        }),
        marker: readProjectMarker(cwd),
      });
      if (banner) additionalContext = `${banner}\n\n${additionalContext}`;
    } catch { /* recognition is additive; never break the session for it */ }

    // Always prepend the injected directives (memory-first + record-intent) —
    // they are static standing instructions and must be present unconditionally
    // (even on empty projects).
    additionalContext = `${INJECTED_DIRECTIVES}\n\n${additionalContext}`;

    let coloredTimeline = '';
    if (showTerminalOutput) {
      // Codex fetches a color-formatted variant through the MCP tool. For other
      // platforms the worker color route was retired; there is no server-side
      // color renderer, so the plain additionalContext is used for terminal
      // display below (see displayContent fallback).
      const mcpColorResult = input.platform === 'codex'
        ? await fetchSessionStartContextViaMcp({
            projects: context.allProjects,
            ...(normalizedPlatformSource ? { platformSource: normalizedPlatformSource } : {}),
            colors: true,
          })
        : null;
      if (mcpColorResult !== null) {
        coloredTimeline = mcpColorResult;
      }
    }

    const platform = input.platform;

    // Only Codex can populate `coloredTimeline` now (via its MCP color fetch);
    // the worker-side color renderer was retired with `/api/context/inject`.
    // Every other platform falls back to the plain additionalContext for
    // terminal display when terminal output is enabled.
    const displayContent = coloredTimeline || (platform === 'codex' ? '' : additionalContext);

    // The live dashboard link is already surfaced above (📊 MemSmith dashboard,
    // via resolveDashboardUrl). The old "View Observations Live @ :<workerPort>"
    // line pointed at the retired SQLite worker and is dead — dropped.
    const systemMessage = showTerminalOutput && displayContent
      ? displayContent
      : undefined;

    // Sprint 3: opt-in team-memory injection (default OFF — default path is byte-identical to pre-sprint3).
    const teamInject = settings.MEMSMITH_TEAM_INJECT === 'true';
    if (teamInject) {
      // Team-memory bridge: this SessionStart handler runs in WORKER mode, but
      // team memory lives in the SERVER-mode Postgres store (Sprints 1-2). We
      // bridge by calling the server's scoped /v1/search with a read key rather
      // than giving the worker a Postgres connection. Fully opt-in: requires the
      // flag AND a configured server URL AND a key — any missing piece disables
      // it. fetchTeamMemory never throws and returns [] on any error, so a team
      // fetch can never break session startup. Default path is unaffected.
      try {
        const rows = await fetchTeamMemory({
          serverUrl: settings.MEMSMITH_TEAM_SERVER_URL ?? '',
          apiKey: settings.MEMSMITH_TEAM_API_KEY ?? '',
          projectId: context.primary,
          teamId: '',  // team is resolved server-side from the scoped key
          query: context.primary,
        });
        const teamBlock = await buildInjectionBlock(
          { hybridSearch: async () => rows },
          { projectId: context.primary, teamId: '', query: context.primary },
        );
        additionalContext = appendTeamMemoryInjection(additionalContext, teamBlock);
      } catch (error) {
        // Belt-and-suspenders: fetchTeamMemory already swallows errors, but never
        // let team injection break the session — log and continue unchanged.
        logger.warn('HOOK', 'team-memory injection failed; continuing without it', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext
      },
      systemMessage
    };
  }
};
