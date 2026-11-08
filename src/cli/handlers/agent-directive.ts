// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - hookSpecificOutput.permissionDecision → ALLOW (never blocks a spawn)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { standingDirectives } from '../../services/retrieval/directive.js';
import { isFeatureEnabled, writesAllowed } from '../../shared/feature-switches.js';

/** PreToolUse:Agent — when the parent spawns a sub-agent (Task/Agent tool),
 *  inject the standing directives so they ride into the sub-agent's task
 *  framing (sub-agents get no SessionStart).
 *  Never blocks the spawn. */
export const agentDirectiveHandler: EventHandler = {
  async execute(_input: NormalizedHookInput): Promise<HookResult> {
    if (!isFeatureEnabled('subagent-directive')) return { continue: true, suppressOutput: true };
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: standingDirectives(writesAllowed()),
        permissionDecision: 'allow',
      },
    };
  },
};
