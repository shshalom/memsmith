// SPDX-License-Identifier: Apache-2.0
// Guards the hooks.json wiring: the discovery-gate PreToolUse entry must exist
// alongside the untouched Read->file-context entry, and the JSON stays valid.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';

describe('plugin/hooks/hooks.json', () => {
  const h = JSON.parse(readFileSync('plugin/hooks/hooks.json', 'utf8'));

  it('is well-formed with a PreToolUse array', () => {
    expect(h.hooks).toBeDefined();
    expect(Array.isArray(h.hooks.PreToolUse)).toBe(true);
  });

  it('keeps the existing Read -> file-context entry unchanged', () => {
    const read = h.hooks.PreToolUse.find((e: any) => e.matcher === 'Read');
    expect(read).toBeDefined();
    expect(read.hooks.some((hh: any) => hh.command.endsWith('hook claude-code file-context'))).toBe(true);
  });

  it('adds a Grep|Glob|WebSearch -> discovery-gate entry', () => {
    const gate = h.hooks.PreToolUse.find((e: any) => (e.matcher ?? '').includes('Grep'));
    expect(gate).toBeDefined();
    expect(gate.matcher).toContain('Glob');
    expect(gate.matcher).toContain('WebSearch');
    expect(gate.hooks.some((hh: any) => hh.command.endsWith('hook claude-code discovery-gate'))).toBe(true);
  });

  it('the discovery-gate command matches the file-context command except the event name', () => {
    const read = h.hooks.PreToolUse.find((e: any) => e.matcher === 'Read').hooks[0].command;
    const gate = h.hooks.PreToolUse.find((e: any) => (e.matcher ?? '').includes('Grep')).hooks[0].command;
    expect(read.replace('hook claude-code file-context', 'hook claude-code discovery-gate')).toBe(gate);
  });

  it('has a PreToolUse interceptor for observation_add', () => {
    const groups = h.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
    const g = groups.find(x => x.matcher === 'mcp__plugin_memsmith_mem__observation_add');
    expect(g).toBeDefined();
    expect(g!.hooks[0].command).toContain('hook claude-code record-intent-intercept');
  });
});
