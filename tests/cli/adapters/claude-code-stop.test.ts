import { describe, it, expect } from 'bun:test';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

describe('claudeCodeAdapter — Stop hook contract', () => {
  it('forwards stop_hook_active so a Stop gate can avoid blocking twice', () => {
    const input = claudeCodeAdapter.normalizeInput({ session_id: 's', cwd: '/tmp', stop_hook_active: true });
    expect(input.stopHookActive).toBe(true);
  });

  it('leaves stopHookActive unset when Claude Code omits it', () => {
    const input = claudeCodeAdapter.normalizeInput({ session_id: 's', cwd: '/tmp' });
    expect(input.stopHookActive).toBeUndefined();
  });

  it('emits a top-level block decision and reason', () => {
    expect(claudeCodeAdapter.formatOutput({ continue: true, decision: 'block', reason: 'search memory' }))
      .toEqual({ decision: 'block', reason: 'search memory' });
  });

  it('emits nothing extra for a plain continue', () => {
    expect(claudeCodeAdapter.formatOutput({ continue: true, suppressOutput: true })).toEqual({});
  });
});
