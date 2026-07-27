// SPDX-License-Identifier: Apache-2.0
//
// Keep the agent's own plumbing out of generated memory.
//
// MemSmith was turning tool calls into project knowledge: "Agent decided to use
// 'mcp__voicesmith__speak'" — a record of the assistant operating its own
// tooling, which can never answer "why is the code like this?". Worse, the
// generator filled the decision template's rejected_alternatives field with
// invented deliberation ("considered using other tools, but chose voicesmith")
// that never occurred. 26 such rows accumulated in the dogfood, 8 typed
// `decision`; five were injected into a single turn, crowding out real context.
//
// The distinction is NOT "tool call vs not" — Read/Grep/Edit are tools, and what
// a file contains is exactly what memory should hold. It is whether the AGENT
// ITSELF is the subject. A file's contents: keep. The agent choosing to read it:
// drop.
//
// Fails OPEN: anything unrecognised is kept, because losing real memory is worse
// than keeping one noisy row.

// Tools that only ever describe the agent operating its own harness. These were
// previously declared in MEMSMITH_SKIP_TOOLS, which was read nowhere in src/ —
// the intent existed, the wiring did not.
const HARNESS_CONTROL_TOOLS = new Set([
  'todowrite',
  'askuserquestion',
  'skill',
  'slashcommand',
  'listmcpresourcestool',
  'exitplanmode',
  'enterplanmode',
]);

export interface AgentEventLike {
  eventType?: string | null;
  toolName?: string | null;
}

/**
 * Whether plumbing events should be dropped. Registry default is true (skip),
 * so a fresh install gets clean memory; a user can opt back into capturing the
 * noise via the `skipAgentPlumbing` setting / MEMSMITH_SKIP_AGENT_PLUMBING.
 *
 * Resolves env > settings file > default-on, matching how the rest of MemSmith
 * resolves configuration. Reading only process.env would silently disable the
 * setting on a real install, since MemSmith's settings live in settings.json —
 * the defect pattern that broke provider selection and identity minting.
 */
export function skipAgentPlumbingEnabled(
  env: Record<string, string | undefined> = process.env,
  settings?: Record<string, unknown>,
): boolean {
  const raw = (env.MEMSMITH_SKIP_AGENT_PLUMBING ?? '').trim().toLowerCase()
    || String(settings?.MEMSMITH_SKIP_AGENT_PLUMBING ?? '').trim().toLowerCase();
  if (!raw) return true; // default: skip the noise
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export function isAgentPlumbingEvent(event: AgentEventLike): boolean {
  const tool = (event?.toolName ?? '').trim().toLowerCase();
  if (!tool) return false;

  // Every MCP tool is external wiring the agent drives — a voice synthesiser, an
  // issue tracker, MemSmith's own note tool. None of it is knowledge about the
  // project being worked on. Prefix-matched so a tool merely containing "mcp"
  // mid-name is unaffected.
  if (tool.startsWith('mcp__')) return true;

  return HARNESS_CONTROL_TOOLS.has(tool);
}
