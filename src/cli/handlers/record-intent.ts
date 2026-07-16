// src/cli/handlers/record-intent.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

// Layer-2 backstop trigger: POST the prompt to /v1/record-intent so the server
// provider can classify+compose+capture a record request the agent may have
// missed. Fail-open: never blocks the prompt; any error → continue.
export const recordIntentHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) return CONTINUE;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_RECORD_INTENT_BACKSTOP !== 'true') return CONTINUE;
      const runtime = resolveRuntimeContext();
      if (runtime.runtime !== 'server') return CONTINUE;
      // Best-effort fire; the server writes on a positive classification.
      await runtime.client.recordIntent({ projectId: runtime.projectId, prompt });
    } catch (err) {
      logger.debug('HOOK', 'record-intent backstop failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
    }
    return CONTINUE;
  },
};
