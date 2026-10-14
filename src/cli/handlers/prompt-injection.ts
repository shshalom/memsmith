import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { SessionShownStore } from '../../services/retrieval/session-store.js';
import { SessionTopicStore } from '../../services/retrieval/topic-store.js';
import { AnswerGateStore } from '../../services/retrieval/answer-gate-store.js';
import { classifyPrompt } from '../../services/retrieval/info-request.js';
import { topicKey } from '../../services/retrieval/topic-key.js';
import { enforcementModeFromSettings } from '../../services/retrieval/enforcement-mode.js';
import { frameAnswerFromMemoryDirective, frameUnavailableNotice } from '../../services/retrieval/directive.js';
import { resolveRuntimeContext, type RuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

function inject(additionalContext: string): HookResult {
  if (!additionalContext) return CONTINUE;
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
  };
}

/** Best-effort gap persistence: record that a why/decision prompt had no memory,
 *  so the dashboard can surface un-captured rationale. Never throws. */
async function persistGap(runtime: RuntimeContext, prompt: string): Promise<void> {
  try {
    if (runtime.runtime !== 'server') return;
    // The direct-insert API (/v1/memories) takes `kind`, not `obsType`; gap
    // markers use kind='memory_gap' + a metadata flag so the dashboard can filter them.
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

export interface PromptInjectionDeps {
  loadSettings: () => Record<string, string>;
  resolveRuntime: () => RuntimeContext;
  /** Test seam for the per-session state directory. */
  sessionBaseDir?: string;
}

const defaultDeps: PromptInjectionDeps = {
  loadSettings: () => ({ ...loadFromFileOnce() }),
  resolveRuntime: () => resolveRuntimeContext(),
};

export function createPromptInjectionHandler(deps: PromptInjectionDeps = defaultDeps): EventHandler {
  const base = deps.sessionBaseDir;
  return {
    async execute(input: NormalizedHookInput): Promise<HookResult> {
      const prompt = (input.prompt ?? '').trim();
      if (!prompt) return CONTINUE;
      const gate = base ? new AnswerGateStore(input.sessionId, base) : new AnswerGateStore(input.sessionId);
      // Cleared first so a failure below can never leave the previous turn's
      // request pending for this turn's Stop.
      gate.beginTurn({ pending: false, topic: '' });
      try {
        const settings = deps.loadSettings();
        if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return CONTINUE;
        const runtime = deps.resolveRuntime();
        const broker = new RetrievalBroker(
          { runtime, settings, sessionId: input.sessionId, nowIso: new Date().toISOString() },
          base ? new SessionShownStore(input.sessionId, base) : undefined,
          base ? new SessionTopicStore(input.sessionId, base) : undefined,
        );

        if (classifyPrompt(prompt) === 'info-request') {
          const probe = await broker.probe(prompt);
          if (probe.unavailable) return inject(frameUnavailableNotice());
          if (probe.isGap) await persistGap(runtime, prompt);
          gate.beginTurn({ pending: true, topic: topicKey(prompt) });
          return inject(frameAnswerFromMemoryDirective(enforcementModeFromSettings(settings)));
        }

        const result = await broker.forPrompt(prompt);
        if (result.isGap) await persistGap(runtime, prompt);
        return inject(result.additionalContext);
      } catch (err) {
        logger.warn('HOOK', 'prompt-injection failed; continuing without it', { error: err instanceof Error ? err.message : String(err) });
        return CONTINUE;
      }
    },
  };
}

export const promptInjectionHandler: EventHandler = createPromptInjectionHandler();
