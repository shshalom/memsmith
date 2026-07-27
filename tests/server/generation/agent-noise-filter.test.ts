// SPDX-License-Identifier: Apache-2.0
//
// MemSmith was recording the agent's OWN plumbing as project knowledge:
// "Agent decided to use 'mcp__voicesmith__speak'", complete with invented
// rationale ("considered using other tools, but chose voicesmith instead" —
// no such deliberation happened). 26 such rows accumulated in the dogfood, 8
// of them typed `decision` — the highest-value category, the "why" a user most
// wants recalled. Five were injected into a single session turn, displacing
// real project context inside a limited recall budget.
//
// The test for whether an event is worth generating from is NOT "is it a tool
// call" — Read/Grep/Edit are tools too, and what a file contains is valuable.
// It is whether the AGENT ITSELF is the subject. A file's contents: keep. The
// agent deciding to read that file: drop.
import { describe, it, expect } from 'bun:test';
import { isAgentPlumbingEvent, skipAgentPlumbingEnabled } from '../../../src/server/generation/agent-noise-filter.js';

function ev(toolName: string | null, extra: Record<string, unknown> = {}) {
  return { eventType: 'tool_use', toolName, payload: extra } as never;
}

describe('agent plumbing is not project knowledge', () => {
  it('drops MCP tool calls — they are agent wiring, never project facts', () => {
    expect(isAgentPlumbingEvent(ev('mcp__voicesmith__speak'))).toBe(true);
    expect(isAgentPlumbingEvent(ev('mcp__plugin_memsmith_mem__note_add'))).toBe(true);
    expect(isAgentPlumbingEvent(ev('mcp__atlassian__createJiraIssue'))).toBe(true);
  });

  it('drops the harness-control tools that were already listed as skippable', () => {
    // These were declared in MEMSMITH_SKIP_TOOLS but the setting was read
    // NOWHERE in src/ — dead configuration. Same intent, now actually wired.
    for (const t of ['TodoWrite', 'AskUserQuestion', 'Skill', 'SlashCommand', 'ListMcpResourcesTool']) {
      expect(isAgentPlumbingEvent(ev(t))).toBe(true);
    }
  });

  it('KEEPS the tools whose output is real project knowledge', () => {
    // The distinction that matters: these produce facts about the codebase.
    for (const t of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch']) {
      expect(isAgentPlumbingEvent(ev(t))).toBe(false);
    }
  });

  it('keeps assistant messages — they carry reasoning about the work', () => {
    expect(isAgentPlumbingEvent({ eventType: 'assistant_message', toolName: null } as never)).toBe(false);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isAgentPlumbingEvent(ev('  MCP__Voicesmith__Speak  '))).toBe(true);
    expect(isAgentPlumbingEvent(ev('todowrite'))).toBe(true);
  });

  it('keeps an event with no tool name rather than guessing', () => {
    // Unknown shape must not be silently dropped — losing real memory is worse
    // than keeping one noisy row.
    expect(isAgentPlumbingEvent(ev(null))).toBe(false);
    expect(isAgentPlumbingEvent(ev(''))).toBe(false);
  });

  it('does not drop a tool merely because its name contains "mcp" mid-word', () => {
    expect(isAgentPlumbingEvent(ev('ImportMcpConfig'))).toBe(false);
  });
});

describe('the skip setting', () => {
  it('is ON by default so a fresh install gets clean memory', () => {
    expect(skipAgentPlumbingEnabled({}, {})).toBe(true);
  });

  it('can be turned off, so a user who wants the noise can have it', () => {
    for (const off of ['false', '0', 'off', 'no', 'FALSE']) {
      expect(skipAgentPlumbingEnabled({ MEMSMITH_SKIP_AGENT_PLUMBING: off }, {})).toBe(false);
    }
  });

  it('reads the value from settings.json, not just process.env', () => {
    // Reading only process.env is the defect pattern that silently disabled
    // provider selection and identity minting — MemSmith's settings live in
    // ~/.memsmith/settings.json.
    expect(skipAgentPlumbingEnabled({}, { MEMSMITH_SKIP_AGENT_PLUMBING: 'false' })).toBe(false);
  });

  it('lets env win over settings', () => {
    expect(skipAgentPlumbingEnabled(
      { MEMSMITH_SKIP_AGENT_PLUMBING: 'true' },
      { MEMSMITH_SKIP_AGENT_PLUMBING: 'false' },
    )).toBe(true);
  });

  it('treats any other value as on rather than guessing', () => {
    expect(skipAgentPlumbingEnabled({ MEMSMITH_SKIP_AGENT_PLUMBING: 'yes' }, {})).toBe(true);
    expect(skipAgentPlumbingEnabled({ MEMSMITH_SKIP_AGENT_PLUMBING: '   ' }, {})).toBe(true);
  });
});
