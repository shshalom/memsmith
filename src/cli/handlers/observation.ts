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
import { isIncognito } from '../incognito.js';
import { scrubEventPayload } from '../../server/services/event-payload-scrub.js';
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


/**
 * Persist an event the server could not accept, so it is not lost.
 *
 * Best-effort and never throws: this runs inside a PostToolUse hook, and
 * breaking the user's tool call to record memory would be a worse trade than
 * losing the event. Lazily imported so the spool module is never loaded on the
 * happy path.
 */
function spoolFailedEvent(event: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spool = require('./capture-spool.js') as typeof import('./capture-spool.js');
    spool.spoolEvent(spool.defaultSpoolPath(), event);
  } catch {
    // Nothing further to do — the event is lost, but the user's tool call is not.
  }
}

/**
 * Enqueue an event for LOCAL generation (Task 1's durable queue), drained by
 * Task 5's local generation loop.
 *
 * Team mode moves generation off the server and onto this machine — the
 * server now records events with `generate=false` (set centrally in
 * ServerClient via delegateGeneration) and never enqueues its own
 * generation job for them. This is the ONLY thing that queues the event for
 * generation on a laptop, so it must run regardless of whether the POST to
 * the server succeeded: an outage that prevents the raw event from reaching
 * the server must not also cost the observation itself.
 *
 * Best-effort and never throws, matching spoolFailedEvent's contract and for
 * the same reason: this runs inside a PostToolUse hook, so breaking the
 * user's tool call over a queue-write failure would be a worse trade than
 * losing the event. Lazily imported so the queue module is never loaded on
 * the local-mode happy path.
 */
function enqueueForLocalGeneration(event: unknown): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const queue = require('../../services/generation/local-queue.js') as typeof import('../../services/generation/local-queue.js');
    queue.enqueueForGeneration(event);
  } catch {
    // Nothing further to do — see spoolFailedEvent's identical rationale.
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

    if (isIncognito(sessionId)) {
      logger.debug('HOOK', 'Incognito session — suppressing capture', { toolName });
      return { continue: true, suppressOutput: true };
    }

    const runtime = resolveRuntimeContext(cwd);
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
          tool_input: scrubEventPayload(toolInput),
          tool_response: scrubEventPayload(toolResponse),
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
        },
      };
      // Enqueue for local generation FIRST, before the POST attempt below —
      // and outside its try/catch — so a server outage during recordEvent
      // can never skip it. Team mode generates on this laptop now; this
      // queue write is the only thing that schedules that generation, so it
      // must not share fate with the network call.
      enqueueForLocalGeneration(event);
      try {
        await runtime.client.recordEvent(event);
        logger.debug('HOOK', 'Observation sent successfully via server', { toolName });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // Spool it rather than dropping it. This used to fall through to a
          // "clean skip", which meant the event was gone: no queue row, no local
          // copy, nothing for any drain to replay. Capture is the one path with
          // no second chance — every other recovery in the system works on rows
          // that already reached Postgres.
          spoolFailedEvent(event);
        } else {
          logger.error('HOOK', 'Server event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    // No server runtime reachable (embedded not yet available). Previously a
    // "clean skip" that silently discarded the event — the single largest source
    // of permanently missing memory, because it fires exactly during the
    // cold-boot window when the server has not started yet. Spool it instead;
    // the next session start flushes it.
    logger.debug('HOOK', 'No reachable runtime for observation; spooling', { toolName });
    spoolFailedEvent({
      projectId: null,
      contentSessionId: sessionId,
      platformSource,
      sourceType: 'hook',
      eventType: 'tool_use',
      occurredAtEpoch: Date.now(),
      payload: {
        tool_name: toolName,
        tool_input: scrubEventPayload(toolInput),
        tool_response: scrubEventPayload(toolResponse),
        cwd,
        agentId: input.agentId,
        agentType: input.agentType,
        platformSource,
      },
    });
    return { continue: true, suppressOutput: true };
  },
};
