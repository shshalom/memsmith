import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// MemSmith must not identify ITSELF as Claude-Mem anywhere. Legitimate
// references to the OTHER product (migration, compat, contrastive comments)
// are allowlisted — they name claude-mem correctly because they interoperate
// with or contrast against it.
const ROOT = join(import.meta.dir, '..', '..');
const ALLOWLIST = [
  'scripts/migrate-claude-mem.ts',
  'src/server/runtime/import/sqliteReader.ts',
  'src/server/compat/',
  'src/ui/viewer/views/ObservationsView.tsx', // explanatory comment: "NOT the legacy claude-mem set"
];

describe('no Claude-Mem self-identity', () => {
  it('src/ and plugin/ contain no un-allowlisted claude-mem string', () => {
    // ripgrep-style scan via git grep; case-insensitive; source + shipped plugin
    // config (exclude .cjs build artifacts and node_modules).
    let out = '';
    try {
      out = execSync(
        `git grep -niE "claude-mem|claude_mem|claudemem" -- 'src/**/*.ts' 'src/**/*.tsx' 'plugin/**/*.json' ':!plugin/scripts/*.cjs'`,
        { cwd: ROOT, encoding: 'utf-8' });
    } catch (e: any) {
      // git grep exits 1 when there are no matches — that's the pass case.
      if (e.status === 1) out = '';
      else throw e;
    }
    const offending = out.split('\n').filter(Boolean).filter(line => {
      const file = line.split(':')[0];
      return !ALLOWLIST.some(alw => file.startsWith(alw) || file.includes(alw));
    });
    expect(offending, `un-allowlisted claude-mem refs:\n${offending.join('\n')}`).toEqual([]);
  });
});
