// src/cli/handlers/answer-gate.ts
// SPDX-License-Identifier: Apache-2.0
//
// Claude Code Stop: hold back an answer to a request for information about past
// work until memory has been searched (hard mode only), then run summarize.
//
// One process runs both steps, in order. As two parallel Stop hooks, summarize
// would record the unsearched answer and end the session on the blocked Stop,
// then skip the real final answer on the continuation Stop.

import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { AnswerGateStore } from '../../services/retrieval/answer-gate-store.js';
import { enforcementModeFromSettings } from '../../services/retrieval/enforcement-mode.js';
import { ANSWER_GATE_BLOCK_REASON } from '../../services/retrieval/directive.js';
import { resolveRuntimeContext, type RuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { summarizeHandler } from './summarize.js';

export interface AnswerGateDeps {
  loadSettings: () => Record<string, string>;
  resolveRuntime: (cwd?: string) => RuntimeContext;
  summarize: EventHandler;
  /** Test seam for the per-session state directory. */
  sessionBaseDir?: string;
}

const defaultDeps: AnswerGateDeps = {
  loadSettings: () => ({ ...loadFromFileOnce() }),
  resolveRuntime: (cwd) => resolveRuntimeContext(cwd),
  summarize: summarizeHandler,
};

function shouldBlock(input: NormalizedHookInput, deps: AnswerGateDeps, gate: AnswerGateStore): boolean {
  if (input.stopHookActive === true) return false;
  if (input.agentId) return false;
  if (!gate.isUnsatisfied()) return false;
  if (enforcementModeFromSettings(deps.loadSettings()) !== 'hard') return false;
  return deps.resolveRuntime(input.cwd).runtime === 'server';
}

export function createAnswerGateHandler(deps: AnswerGateDeps = defaultDeps): EventHandler {
  return {
    async execute(input: NormalizedHookInput): Promise<HookResult> {
      try {
        const gate = deps.sessionBaseDir
          ? new AnswerGateStore(input.sessionId, deps.sessionBaseDir)
          : new AnswerGateStore(input.sessionId);
        if (shouldBlock(input, deps, gate)) {
          gate.markBlocked();
          return { continue: true, suppressOutput: true, decision: 'block', reason: ANSWER_GATE_BLOCK_REASON };
        }
      } catch (err) {
        logger.warn('HOOK', 'answer-gate failed; letting the turn end', { error: err instanceof Error ? err.message : String(err) });
      }
      // Claude Code never forwarded stop_hook_active to summarize before this
      // gate existed, so summarize ran on every Stop. Keep that: the
      // continuation Stop after a block is the one that carries the final answer.
      return deps.summarize.execute({ ...input, stopHookActive: undefined });
    },
  };
}

export const answerGateHandler: EventHandler = createAnswerGateHandler();
