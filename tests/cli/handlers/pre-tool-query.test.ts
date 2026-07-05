// SPDX-License-Identifier: Apache-2.0
// The discovery-gate query derivation: turn a PreToolUse tool input into a
// memory query so the gate can inject relevant memory before an expensive
// re-discovery tool (Grep/Glob/WebSearch) runs. Pure + tunable via env.
import { describe, it, expect } from 'bun:test';
import { shouldGateTool, buildPreToolQuery } from '../../../src/cli/handlers/pre-tool-query.js';

describe('shouldGateTool', () => {
  it('gates the configured discovery tools (default set)', () => {
    expect(shouldGateTool('Grep', '')).toBe(true);
    expect(shouldGateTool('Glob', '')).toBe(true);
    expect(shouldGateTool('WebSearch', '')).toBe(true);
    expect(shouldGateTool('Read', '')).toBe(true);
  });
  it('does not gate unrelated tools', () => {
    expect(shouldGateTool('TodoWrite', '')).toBe(false);
    expect(shouldGateTool('Bash', '')).toBe(false);
  });
  it('honors an explicit CLAUDE_MEM_GATE_TOOLS override', () => {
    expect(shouldGateTool('Grep', 'Read')).toBe(false);   // only Read gated
    expect(shouldGateTool('Read', 'Read')).toBe(true);
    expect(shouldGateTool('Bash', 'Bash,Grep')).toBe(true);
  });
  it('empty override disables all gating', () => {
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
