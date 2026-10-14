import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

export const claudeCodeAdapter: PlatformAdapter = {
  normalizeInput(raw) {
    const r = (raw ?? {}) as any;
    const cwd = r.cwd ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }
    return {
      sessionId: r.session_id ?? r.id ?? r.sessionId,
      cwd,
      prompt: r.prompt,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      toolResponse: r.tool_response,
      transcriptPath: r.transcript_path,
      stopHookActive: r.stop_hook_active === true ? true : undefined,
      agentId: pickAgentField(r.agent_id),
      agentType: pickAgentField(r.agent_type),
    };
  },
  formatOutput(result) {
    const r = result ?? ({} as HookResult);
    const output: Record<string, unknown> = {};
    if (r.hookSpecificOutput) output.hookSpecificOutput = r.hookSpecificOutput;
    if (r.systemMessage) output.systemMessage = r.systemMessage;
    if (r.decision === 'block') {
      output.decision = 'block';
      if (r.reason) output.reason = r.reason;
    }
    return output;
  }
};
