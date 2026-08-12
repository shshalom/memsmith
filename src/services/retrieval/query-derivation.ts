/** Tools whose purpose is discovery/search — the ones retrieval-first intercepts.
 *  Bash is handled specially (only search commands count). Read was REMOVED
 *  2026-08-11: see the `case 'Read'` comment below. */
export const SEARCH_INTENT_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'Bash']);

/**
 * A Bash command counts as search intent only when a search tool is the FIRST
 * thing invoked — the command actually being run, not any substring.
 *
 * The previous pattern was /(^|\s)(grep|rg|ag|find)\b/, matching a search word
 * anywhere. Found live 2026-08-11: a mutation-test script
 * (`cp && perl && grep -c && bun test`) was gated as a discovery search, as was
 * any build piping through grep. Anchoring to the start (after optional leading
 * whitespace or an absolute path) keeps real searches gated while routine
 * pipelines that merely mention grep are not.
 */
const BASH_SEARCH_PREFIX = /^\s*(?:[\w./-]*\/)?(grep|rg|ag|find)\b/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

export interface DeriveOpts {
  /** Retained for call-site compatibility; unused since Read stopped being gated.
   *  Kept so the broker's `{ warmPaths }` call site needs no change and so a
   *  future path-aware gate has somewhere to land. */
  warmPaths?: ReadonlySet<string>;
}

/** Derive a /v1/context query from a tool call, or null if the call is not a
 *  search-intent we should intercept. Never throws. */
export function deriveQueryFromTool(
  toolName: string,
  toolArgs: unknown,
  _opts: DeriveOpts = {},
): string | null {
  const args = asRecord(toolArgs);
  if (!args) return null;
  switch (toolName) {
    case 'Grep':
    case 'Glob': {
      const p = args.pattern;
      return typeof p === 'string' && p.length > 0 ? p : null;
    }
    // Read is NOT gated (changed 2026-08-11 after live friction).
    //
    // It was gated to cold reads only, but even that taxed normal work: opening a
    // spec or a source file is a routine part of any investigation and is rarely a
    // why-question, so the block bought little signal for real cost. Grep and Glob
    // remain gated because they ARE search intent. Narrowing to Grep/Glob was also
    // the fix direction recorded in the July over-blocking notes.
    //
    // Kept as an explicit case rather than falling through to default, so the
    // decision is visible at the point someone would try to re-add it.
    case 'Read':
      return null;
    case 'Bash': {
      const cmd = args.command;
      if (typeof cmd !== 'string' || !BASH_SEARCH_PREFIX.test(cmd)) return null;
      // Extract quoted search term if present, else the whole command tail.
      const quoted = cmd.match(/["']([^"']+)["']/);
      return quoted ? quoted[1] : cmd.replace(BASH_SEARCH_PREFIX, ' ').trim();
    }
    default:
      return null;
  }
}
