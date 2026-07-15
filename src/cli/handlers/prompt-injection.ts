import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

/** Best-effort gap persistence: record that a why/decision prompt had no memory,
 *  so the dashboard can surface un-captured rationale. Never throws. */
async function persistGap(runtime: ReturnType<typeof resolveRuntimeContext>, prompt: string): Promise<void> {
  try {
    if (runtime.runtime !== 'server') return;
    // NOTE: the direct-insert API (ServerAddObservationRequest → /v1/memories) uses
    // `kind`, not `obsType` (obs_type is a generation-time field). Gap markers use
    // kind='memory_gap' + a metadata flag so the dashboard can filter them.
    await runtime.client.addObservation({
      projectId: runtime.projectId,
      kind: 'memory_gap',
      content: `memory_gap: no recorded rationale for prompt: ${prompt.slice(0, 200)}`,
      metadata: { memoryGap: true },
    });
  } catch (err) {
    logger.debug('HOOK', 'gap persist failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
  }
}

export const promptInjectionHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) return CONTINUE;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return CONTINUE;
      const runtime = resolveRuntimeContext();
      const broker = new RetrievalBroker({ runtime, settings, sessionId: input.sessionId, nowIso: new Date().toISOString() });
      const result = await broker.forPrompt(prompt);
      if (result.isGap) { await persistGap(runtime, prompt); }
      if (!result.additionalContext) return CONTINUE;
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: result.additionalContext,
        },
      };
    } catch (err) {
      logger.warn('HOOK', 'prompt-injection failed; continuing without it', { error: err instanceof Error ? err.message : String(err) });
      return CONTINUE;
    }
  },
};
