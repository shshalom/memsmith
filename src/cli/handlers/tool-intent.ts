// src/cli/handlers/tool-intent.ts
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

/** PreToolUse must default to allowing the tool through — retrieval-first never
 *  blocks the agent due to its own failure. */
const ALLOW: HookResult = {
  continue: true,
  suppressOutput: true,
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '', permissionDecision: 'allow' },
};

export const toolIntentHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const toolName = input.toolName ?? '';
    if (!toolName) return ALLOW;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return ALLOW;
      const runtime = resolveRuntimeContext();
      const broker = new RetrievalBroker({ runtime, settings: { ...settings }, sessionId: input.sessionId, nowIso: new Date().toISOString() });
      const result = await broker.forToolIntent(toolName, input.toolInput);
      if (result.block) {
        return {
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: result.additionalContext,
            permissionDecision: 'deny',
            permissionDecisionReason: result.blockReason ?? 'Consult MemSmith memory first.',
          },
        };
      }
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: result.additionalContext,
          permissionDecision: 'allow',
        },
      };
    } catch (err) {
      logger.warn('HOOK', 'tool-intent failed; allowing tool through', { error: err instanceof Error ? err.message : String(err) });
      return ALLOW;
    }
  },
};
