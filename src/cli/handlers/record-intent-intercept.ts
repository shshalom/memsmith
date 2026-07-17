// src/cli/handlers/record-intent-intercept.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RecordArmedStore } from '../../services/retrieval/record-armed-store.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };
const OBSERVATION_ADD_TOOL = 'mcp__plugin_memsmith_mem__observation_add';

// PreToolUse interceptor: during a record-intent turn (armed stash), rewrite an
// observation_add call's arguments in-flight so it lands as a findable user note
// (kind='user_note', userDirected). Deterministic — no dependence on the agent
// choosing note_add. Fail-open: never denies, never blocks; any error → allow unchanged.
export const recordIntentInterceptHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    try {
      if (input.toolName !== OBSERVATION_ADD_TOOL) return CONTINUE;
      const rec = new RecordArmedStore(input.sessionId).read();
      if (!rec?.armed) return CONTINUE;
      const ti = input.toolInput;
      if (typeof ti !== 'object' || ti === null) return CONTINUE;
      const content = (ti as { content?: unknown }).content;
      if (typeof content !== 'string' || content.trim().length === 0) return CONTINUE;
      const existingMeta = (ti as { metadata?: unknown }).metadata;
      const metadata = {
        ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta as Record<string, unknown> : {}),
        userDirected: true,
      };
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: '',
          updatedInput: { ...(ti as Record<string, unknown>), kind: 'user_note', metadata },
        },
      };
    } catch (err) {
      logger.debug('HOOK', 'record-intent interceptor failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
      return CONTINUE;
    }
  },
};
