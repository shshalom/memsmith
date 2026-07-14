
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import { isServerClientError, type ServerRecordEventRequest } from '../../services/hooks/server-client.js';

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, filePath, edits } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      editCount: edits?.length ?? 0
    });

    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file edit observation', { cwd, filePath });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Worker retirement — the file-edit observation formerly POSTed to the
    // worker route `/api/sessions/observations`. Repointed to the same
    // runtime-selector + ServerClient capture path the PostToolUse observation
    // handler uses (POST /v1/events, eventType tool_use). Clean-skip when no
    // server runtime is reachable — the hook never blocks the edit.
    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server') {
      const event: ServerRecordEventRequest = {
        projectId: runtime.projectId,
        contentSessionId: sessionId,
        platformSource,
        sourceType: 'hook',
        eventType: 'tool_use',
        occurredAtEpoch: Date.now(),
        payload: {
          tool_name: 'write_file',
          tool_input: { filePath, edits },
          tool_response: { success: true },
          cwd,
          platformSource,
        },
      };
      try {
        await runtime.client.recordEvent(event);
        logger.debug('HOOK', 'File edit observation sent successfully via server', { filePath });
        return { continue: true, suppressOutput: true };
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
          // fall through to clean skip (worker fallback retired)
        } else {
          logger.error('HOOK', 'Server file-edit event failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    // No server runtime reachable (embedded not yet available). Worker fallback
    // retired; skip cleanly so the hook never blocks the file edit.
    logger.debug('HOOK', 'No reachable runtime for file edit observation; skipping', { filePath });
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
