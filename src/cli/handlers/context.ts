// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
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

// The SessionStart primary-context budget. Injection is NOT query-driven at
// startup — we pull the most recent observations for the project scope and pack
// them into a string the same way POST /v1/context does server-side.
const SESSION_START_RECENT_LIMIT = 10;

const defaultDependencies = {
  resolveRuntimeContext: defaultResolveRuntimeContext,
  getProjectContext: defaultGetProjectContext,
  loadFromFileOnce: defaultLoadFromFileOnce,
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
    const port = getWorkerPort();

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
    const dashboardLine = `📊 MemSmith dashboard: ${resolveDashboardUrl()}`;
    additionalContext = additionalContext
      ? `${dashboardLine}\n\n${additionalContext}`
      : dashboardLine;

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

    const systemMessage = showTerminalOutput && displayContent
      ? `${displayContent}\n\nView Observations Live @ http://localhost:${port}`
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
