import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { execFileSync } from 'child_process';

// Every shipped or public surface presents MemSmith only: no upstream name,
// author, domain, community invite, or analytics key. The upstream
// attribution required by Apache-2.0 section 4(d) lives in NOTICE, which is
// deliberately outside the scanned paths.
const ROOT = join(import.meta.dir, '..', '..');
const PATTERN = 'claude-mem|claude_mem|claudemem|thedotmack|alex newman|alexnewman|cmem\\.ai|J4wttp9vDu|phc_BKJAeNbpj932|memsmith\\.ai';
const SCANNED_DIRS = [
  'src/',
  'plugin/',
  '.claude-plugin/',
  '.codex-plugin/',
  '.agents/',
  'docs/public/',
  'cursor-hooks/',
  '.github/',
];
const SCANNED_FILES = new Set(['package.json', 'README.md', 'CLAUDE.md', 'SECURITY.md']);
// Reads a claude-mem SQLite database for the import tool and names it as such.
const ALLOWLIST = new Set(['src/server/runtime/import/sqliteReader.ts']);

function isScanned(file: string): boolean {
  return SCANNED_FILES.has(file) || SCANNED_DIRS.some(dir => file.startsWith(dir));
}

function upstreamReferences(): string[] {
  try {
    return execFileSync(
      'git',
      ['grep', '--untracked', '-I', '-n', '-i', '-E', PATTERN],
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    ).split('\n').filter(Boolean);
  } catch (e: any) {
    if (e.status === 1) return [];
    throw e;
  }
}

describe('MemSmith-only identity', () => {
  it('shipped and public files never name the upstream project or its author', () => {
    const offending = upstreamReferences()
      .filter(line => {
        const file = line.slice(0, line.indexOf(':'));
        return isScanned(file) && !ALLOWLIST.has(file);
      })
      .map(line => line.slice(0, 200));
    expect(offending, `upstream references:\n${offending.join('\n')}`).toEqual([]);
  });
});
