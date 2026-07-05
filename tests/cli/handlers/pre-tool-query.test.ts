// SPDX-License-Identifier: Apache-2.0
// The discovery-gate query derivation: turn a PreToolUse tool input into a
// memory query so the gate can inject relevant memory before an expensive
// re-discovery tool (Grep/Glob/WebSearch) runs. Pure + tunable via env.
import { describe, it, expect } from 'bun:test';
import { shouldGateTool, buildPreToolQuery } from '../../../src/cli/handlers/pre-tool-query.js';

describe('shouldGateTool', () => {
  it('is OFF by default (empty) — safe-by-default', () => {
    // Empty means the gate is disabled; the hook fires but no-ops.
    expect(shouldGateTool('Grep', '')).toBe(false);
    expect(shouldGateTool('Read', '')).toBe(false);
    expect(shouldGateTool('WebSearch', '')).toBe(false);
  });
  it("the 'all' sentinel enables the default discovery-tool set", () => {
    expect(shouldGateTool('Grep', 'all')).toBe(true);
    expect(shouldGateTool('Glob', 'all')).toBe(true);
    expect(shouldGateTool('WebSearch', 'all')).toBe(true);
    expect(shouldGateTool('Read', 'all')).toBe(true);
    expect(shouldGateTool('TodoWrite', 'all')).toBe(false);
  });
  it('honors an explicit CLAUDE_MEM_GATE_TOOLS list', () => {
    expect(shouldGateTool('Grep', 'Read')).toBe(false);   // only Read gated
    expect(shouldGateTool('Read', 'Read')).toBe(true);
    expect(shouldGateTool('Bash', 'Bash,Grep')).toBe(true);
  });
  it("'none' explicitly disables all gating", () => {
    expect(shouldGateTool('Grep', 'none')).toBe(false);
  });
});

describe('buildPreToolQuery', () => {
  it('derives a query from a Grep pattern', () => {
    expect(buildPreToolQuery({ pattern: 'PaymentService' })).toContain('PaymentService');
  });
  it('derives a query from a Glob pattern', () => {
    expect(buildPreToolQuery({ pattern: 'src/**/auth*.ts' })).toContain('auth');
  });
  it('derives a query from a WebSearch query', () => {
    expect(buildPreToolQuery({ query: 'how to rotate JWT keys' })).toContain('rotate JWT');
  });
  it('derives a query from a Read file_path (basename, no extension)', () => {
    expect(buildPreToolQuery({ file_path: 'src/auth/jwt.ts' })).toContain('jwt');
  });
  it('returns empty string when nothing usable is present', () => {
    expect(buildPreToolQuery({})).toBe('');
    expect(buildPreToolQuery({ foo: 1 } as any)).toBe('');
  });
});
