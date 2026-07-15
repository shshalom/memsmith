// tests/cli/handlers/tool-intent.test.ts
import { describe, it, expect } from 'bun:test';
import { toolIntentHandler } from '../../../src/cli/handlers/tool-intent.js';

describe('toolIntentHandler', () => {
  it('non-search tool → allow, no block (fail-open path, no runtime)', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Edit', toolInput: { file_path: '/a.ts' } } as any);
    expect(res.continue).toBe(true);
    // never denies a non-search tool
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('search tool with no reachable runtime → allow (fail-open), never throws', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' } } as any);
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('sub-agent tool call (agentId set) still runs the path without throwing', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' }, agentId: 'sub-1', agentType: 'general-purpose' } as any);
    expect(res.continue).toBe(true);
  });
});
