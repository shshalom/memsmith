// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { statSync } from 'fs';
import path from 'path';
import { shouldTrackProject } from '../../shared/should-track-project.js';

const FILE_READ_GATE_MIN_BYTES = 1_500;

const MAX_FILE_CONTEXT_PATHS = 10;

// NOTE (worker retirement): the PreToolUse file-timeline rendering helpers
// (formatFileTimeline / deduplicateObservations / TYPE_ICONS / date helpers)
// were removed together with the dead `/api/observations/by-file` fetch — they
// are dead without the fetch. Reintroducing the timeline only needs a `/v1`
// server-side by-file endpoint wired into buildFileContextTimeline (see that
// function's note). The old rendering lives in git history if needed.

export const fileContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const toolInput = input.toolInput as Record<string, unknown> | undefined;
    const filePaths = Array.isArray(toolInput?.filePaths)
      ? (toolInput.filePaths as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, MAX_FILE_CONTEXT_PATHS)
      : [];
    const filePath = toolInput?.file_path as string | undefined;
    const candidatePaths = filePaths.length > 0 ? filePaths : (filePath ? [filePath] : []);

    if (candidatePaths.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    if (input.cwd && !shouldTrackProject(input.cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping file context', { cwd: input.cwd });
      return { continue: true, suppressOutput: true };
    }

    const timelineResults = await Promise.allSettled(
      candidatePaths.map(candidatePath => buildFileContextTimeline(input, candidatePath))
    );
    const timelines: string[] = [];

    timelineResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value) timelines.push(result.value);
        return;
      }
      logger.debug('HOOK', 'File context timeline lookup failed, skipping path', {
        filePath: candidatePaths[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    if (timelines.length === 0) {
      return { continue: true, suppressOutput: true };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: timelines.join('\n\n---\n\n'),
        permissionDecision: 'allow',
      },
    };
  },
};

// C1 (worker retirement) — the PreToolUse file-timeline injection was served by
// the deleted worker route `/api/observations/by-file`, which queried the SQLite
// `files_read`/`files_modified` columns. The `/v1` Postgres server has NO
// equivalent by-file endpoint: files_read/files_modified are stored inside
// observation `metadata` (JSONB, see processGeneratedResponse.ts) but neither
// /v1/search nor the observation repository exposes a file-path filter. A by-file
// repoint therefore requires NEW server infrastructure (route + repo query +
// ServerClient method), which is out of scope for this repoint/delete fix.
//
// Until that endpoint exists this secondary PreToolUse timeline is disabled: this
// always returns null, which keeps the hook graceful (it never blocks a Read).
// The stat-gate is preserved so re-enabling only needs the by-file fetch wired in
// where noted. See final-fix-report.md (STOPPED item).
async function buildFileContextTimeline(input: NormalizedHookInput, filePath: string): Promise<string | null> {
  try {
    const statPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(input.cwd || process.cwd(), filePath);
    const stat = statSync(statPath);
    if (!stat.isFile() || stat.size < FILE_READ_GATE_MIN_BYTES) {
      return null;
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    logger.debug('HOOK', 'File stat failed, proceeding with gate', { error: err instanceof Error ? err.message : String(err) });
  }

  // No server-side by-file endpoint on the `/v1` runtime (see note above).
  return null;
}
