import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const hooks = JSON.parse(readFileSync(join(process.cwd(), 'plugin/hooks/hooks.json'), 'utf-8'));

function commandsFor(event: string): string[] {
  return (hooks.hooks[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));
}

describe('retrieval-first hooks wired', () => {
  it('UserPromptSubmit runs prompt-injection', () => {
    expect(commandsFor('UserPromptSubmit').some(c => c.includes('hook claude-code prompt-injection'))).toBe(true);
  });
  it('PreToolUse runs tool-intent for search tools', () => {
    expect(commandsFor('PreToolUse').some(c => c.includes('hook claude-code tool-intent'))).toBe(true);
  });
  it('PreToolUse runs agent-directive for Task/Agent spawns', () => {
    const groups = hooks.hooks.PreToolUse ?? [];
    const hasAgentMatcher = groups.some((g: any) =>
      /Task|Agent/.test(g.matcher ?? '') && (g.hooks ?? []).some((h: any) => h.command.includes('hook claude-code agent-directive')));
    expect(hasAgentMatcher).toBe(true);
  });
});
