import { basename, dirname } from 'path';

/** Tools whose purpose is discovery/search — the ones retrieval-first intercepts.
 *  Bash is handled specially (only search commands count). */
export const SEARCH_INTENT_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'Read', 'Bash']);

const BASH_SEARCH_PREFIX = /(^|\s)(grep|rg|ag|find)\b/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

export interface DeriveOpts {
  /** Absolute paths already in the agent's context. A re-read of one of these is
   *  not "seeking information", so it is not gated (Amendment 1, 2026-08-11).
   *  Omit to keep the pre-amendment behavior. */
  warmPaths?: ReadonlySet<string>;
}

/** Derive a /v1/context query from a tool call, or null if the call is not a
 *  search-intent we should intercept. Never throws. */
export function deriveQueryFromTool(
  toolName: string,
  toolArgs: unknown,
  opts: DeriveOpts = {},
): string | null {
  const args = asRecord(toolArgs);
  if (!args) return null;
  switch (toolName) {
    case 'Grep':
    case 'Glob': {
      const p = args.pattern;
      return typeof p === 'string' && p.length > 0 ? p : null;
    }
    case 'Read': {
      const fp = args.file_path;
      if (typeof fp !== 'string' || fp.length === 0) return null;
      // basename (sans extension) + parent dir name make decent query terms.
      const base = basename(fp).replace(/\.[^.]+$/, '');
      const dir = basename(dirname(fp));
      return `${base} ${dir}`.trim();
    }
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
