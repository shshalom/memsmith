// src/cli/handlers/record-intent.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { isRecordIntent } from '../../services/retrieval/record-intent-detect.js';
import { RecordArmedStore } from '../../services/retrieval/record-armed-store.js';
import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { isFeatureEnabled, writesAllowed } from '../../shared/feature-switches.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

const READ_ONLY_RECORD: HookResult = {
  continue: true,
  suppressOutput: false,
  systemMessage: 'MemSmith is in read-only mode for this session (MEMSMITH_MODE=read), so this request is not saved to memory.',
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'MemSmith memory is read-only in this session (MEMSMITH_MODE=read). Do not call note_add or observation_add for this request; they refuse. Tell the user that nothing was recorded to memory because this session is read-only.',
  },
};

export function stripRecordIntentPrompt(prompt: string): string {
  return stripMemoryTags(prompt);
}

// Layer-2 backstop: for a prompt the deterministic detector flags as a record
// request, POST it to /v1/record-intent so the server writes the note even if
// the agent skips note_add. Unflagged prompts never reach the provider: the
// local model classifies ordinary questions as record requests and invents
// note content, and user-directed notes skip the quality floor. Fail-open:
// never blocks the prompt.
export interface RecordIntentDeps {
  loadSettings: () => { MEMSMITH_RECORD_INTENT_BACKSTOP?: string };
  resolveRuntime: () => ReturnType<typeof resolveRuntimeContext>;
  armedStore: (sessionId: string) => Pick<RecordArmedStore, 'write'>;
}

const defaultDeps: RecordIntentDeps = {
  loadSettings: loadFromFileOnce,
  resolveRuntime: () => resolveRuntimeContext(),
  armedStore: (sessionId) => new RecordArmedStore(sessionId),
};

export function createRecordIntentHandler(deps: RecordIntentDeps = defaultDeps): EventHandler {
  return {
    async execute(input: NormalizedHookInput): Promise<HookResult> {
      const prompt = (input.prompt ?? '').trim();
      if (!prompt || !isFeatureEnabled('record-intent')) return CONTINUE;
      const armed = isRecordIntent(prompt);
      if (!writesAllowed()) return armed ? READ_ONLY_RECORD : CONTINUE;
      try {
        deps.armedStore(input.sessionId).write({
          armed,
          promptId: input.turnId ?? null,
          ts: Date.now(),
        });
      } catch {
        // best-effort; a failed arm just leaves the interceptor treating the turn as not-armed
      }
      if (!armed) return CONTINUE;
      try {
        const settings = deps.loadSettings();
        if (settings.MEMSMITH_RECORD_INTENT_BACKSTOP !== 'true') return CONTINUE;
        const runtime = deps.resolveRuntime();
        if (runtime.runtime !== 'server') return CONTINUE;
        // Best-effort fire; the server writes on a positive classification.
        await runtime.client.recordIntent({ projectId: runtime.projectId, prompt: stripRecordIntentPrompt(prompt) });
      } catch (err) {
        logger.debug('HOOK', 'record-intent backstop failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
      }
      return CONTINUE;
    },
  };
}

export const recordIntentHandler: EventHandler = createRecordIntentHandler();
