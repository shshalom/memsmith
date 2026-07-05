// SPDX-License-Identifier: Apache-2.0
// Discovery-gate helpers: decide whether a PreToolUse tool should trigger a
// memory lookup, and derive a query string from its input. Pure + dependency-
// free so they're trivially testable and safe to call on the hot PreToolUse
// path. The set of gated tools is tunable via CLAUDE_MEM_GATE_TOOLS (a comma-
// separated list; the literal "none" disables all gating).

const DEFAULT_GATE_TOOLS = 'Read,Grep,Glob,WebSearch';

/**
 * Whether `toolName` should trigger the discovery gate. `override` is the raw
 * CLAUDE_MEM_GATE_TOOLS value (pass '' to use the default set; pass 'none' to
 * disable). Injected rather than read from env directly for testability.
 */
export function shouldGateTool(toolName: string, override: string): boolean {
  const raw = (override ?? '').trim();
  if (raw.toLowerCase() === 'none') return false;
  const list = (raw || DEFAULT_GATE_TOOLS).split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(toolName);
}

/**
 * Derive a memory query from a tool's input. Handles the shapes of the gated
 * discovery tools: Grep/Glob `pattern`, WebSearch `query`, Read `file_path`
 * (basename without extension). Returns '' when nothing usable is present.
 */
export function buildPreToolQuery(input: Record<string, unknown>): string {
  if (typeof input.query === 'string' && input.query.trim()) {
    return input.query.trim();
  }
  if (typeof input.pattern === 'string' && input.pattern.trim()) {
    // Strip glob/regex punctuation to leave the meaningful terms.
    return input.pattern
      .replace(/[*?{}[\]()^$\\|.+/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (typeof input.file_path === 'string' && input.file_path.trim()) {
    const base = input.file_path.split('/').pop() ?? '';
    return base.replace(/\.[^.]+$/, '').trim();
  }
  return '';
}
