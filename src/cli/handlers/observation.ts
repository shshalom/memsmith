// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import { isServerClientError, type ServerRecordEventRequest } from '../../services/hooks/server-client.js';
import { shouldGateTool, buildPreToolQuery } from './pre-tool-query.js';
import { detectRediscovery } from '../../server/retrieval/rediscovery.js';

export interface RediscoveryLogDeps {
  fetchTeamMemory(input: { serverUrl: string; apiKey: string; projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>;
}

export async function shouldLogRediscovery(
  deps: RediscoveryLogDeps,
  input: { toolName: string; toolInput: Record<string, unknown>; projectName: string; enabled: boolean; gateTools: string; serverUrl: string; apiKey: string },
): Promise<{ rediscovered: boolean; matchedIds: string[] }> {
  try {
    if (!input.enabled) return { rediscovered: false, matchedIds: [] };
    if (!shouldGateTool(input.toolName, input.gateTools)) return { rediscovered: false, matchedIds: [] };
    if (!input.serverUrl.trim() || !input.apiKey.trim()) return { rediscovered: false, matchedIds: [] };
    const toolQuery = buildPreToolQuery(input.toolInput);
    if (!toolQuery) return { rediscovered: false, matchedIds: [] };
    return await detectRediscovery(
      { hybridSearch: async () => deps.fetchTeamMemory({ serverUrl: input.serverUrl, apiKey: input.apiKey, projectId: input.projectName, teamId: '', query: toolQuery, limit: 3 }) },
      { projectId: input.projectName, teamId: '', toolQuery, toolResult: '' },
    );
  } catch {
    return { rediscovered: false, matchedIds: [] };
  }
}


export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    const runtime = resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. `runtime-selector.selectRuntime()` continues to accept the legacy
    // `'server-beta'` literal in settings.json and normalizes it to `'server'`.
    if (runtime.runtime === 'server') {
      const event: ServerRecordEventRequest = {
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        platformSource,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
        },
      };
      try {
        await runtime.client.recordEvent(event);
        logger.debug('HOOK', 'Observation sent successfully via server', { toolName });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // fall through to clean skip (worker fallback retired)
        } else {
          logger.error('HOOK', 'Server event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    // No server runtime reachable (embedded not yet available). The worker
    // fallback has been retired; skip cleanly so the hook never blocks.
    logger.debug('HOOK', 'No reachable runtime for observation; skipping', { toolName });
    return { continue: true, suppressOutput: true };
  },
};
