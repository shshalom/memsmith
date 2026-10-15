// src/cli/handlers/tool-intent.ts
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { SessionTopicStore } from '../../services/retrieval/topic-store.js';
import { WarmPathStore } from '../../services/retrieval/warm-path-store.js';
import { AnswerGateStore } from '../../services/retrieval/answer-gate-store.js';
import { topicKey } from '../../services/retrieval/topic-key.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

/** PreToolUse must default to allowing the tool through — retrieval-first never
 *  blocks the agent due to its own failure. */
const ALLOW: HookResult = Object.freeze({
  continue: true,
  suppressOutput: true,
  hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse', additionalContext: '', permissionDecision: 'allow' }),
});

/**
 * Tools that ARE a memory consultation. A call to one of these is the agent
 * DOING the memory-first step, so it unlocks the topic for the rest of the
 * session.
 *
 * Two properties are load-bearing:
 *  1. These must NEVER be denied. A blocked search plus a blocked way to search
 *     memory is a deadlock — the agent could not satisfy the gate.
 *  2. Without this marking, consulting memory would never clear the gate and
 *     every discovery tool would block forever. This is the single most
 *     important line in the enforcement path.
 */
export const MEMORY_TOOL_PATTERN = /^mcp__plugin_memsmith_mem__/;

/**
 * The memory searches that answer a pending information request.
 * session_start_context returns orientation context, which does not answer a
 * question; smart_* are code structure tools; the *_add / record tools are writes.
 */
export const MEMORY_READ_TOOLS: ReadonlySet<string> = new Set([
  'mcp__plugin_memsmith_mem__observation_search',
  'mcp__plugin_memsmith_mem__observation_get',
  'mcp__plugin_memsmith_mem__observation_context',
]);

/** Test seam: lets tests point the session stores at a temp dir. */
export interface ToolIntentOpts {
  sessionBaseDir?: string;
}

export const toolIntentHandler: EventHandler = {
  async execute(input: NormalizedHookInput, opts?: ToolIntentOpts): Promise<HookResult> {
    const toolName = input.toolName ?? '';
    if (!toolName) return ALLOW;
    const baseDir = opts?.sessionBaseDir;
    try {
      // The agent is consulting memory: record the topic, always allow. Runs
      // BEFORE the settings gate so the gate can be satisfied even if injection
      // is disabled mid-session.
      if (MEMORY_TOOL_PATTERN.test(toolName)) {
        const topics = baseDir
          ? new SessionTopicStore(input.sessionId, baseDir)
          : new SessionTopicStore(input.sessionId);
        if (MEMORY_READ_TOOLS.has(toolName)) {
          const q = (input.toolInput as Record<string, unknown> | null)?.query;
          if (typeof q === 'string' && q.trim()) topics.markConsulted(topicKey(q));
          const gate = baseDir
            ? new AnswerGateStore(input.sessionId, baseDir)
            : new AnswerGateStore(input.sessionId);
          const pending = gate.read();
          if (pending?.pending && pending.topic) topics.markConsulted(pending.topic);
          gate.markSatisfied();
        }
        return ALLOW;
      }

      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return ALLOW;

      // Warm-path bookkeeping (Amendment 1): a re-read of a file already read
      // this session is not discovery. Read the set BEFORE marking, so the
      // current call is judged on prior state, not on itself.
      const warmStore = baseDir
        ? new WarmPathStore(input.sessionId, baseDir)
        : new WarmPathStore(input.sessionId);
      const warmPaths = warmStore.read();
      if (toolName === 'Read') {
        const fp = (input.toolInput as Record<string, unknown> | null)?.file_path;
        if (typeof fp === 'string' && fp) warmStore.mark(fp);
      }

      const runtime = resolveRuntimeContext();
      const broker = new RetrievalBroker(
        { runtime, settings: { ...settings }, sessionId: input.sessionId, nowIso: new Date().toISOString(), warmPaths },
        baseDir ? new SessionTopicStore(input.sessionId, baseDir) : undefined,
      );
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
          // The soft-mode reminder, or the memory-unavailable notice when the
          // gate failed open.
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
