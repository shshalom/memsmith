import { describe, it, expect } from 'bun:test';
import { deriveQueryFromTool } from '../../src/services/retrieval/query-derivation.js';

describe('deriveQueryFromTool', () => {
  it('Grep → the pattern', () => {
    expect(deriveQueryFromTool('Grep', { pattern: 'buildServerContext' })).toBe('buildServerContext');
  });
  it('Glob → the glob pattern', () => {
    expect(deriveQueryFromTool('Glob', { pattern: 'src/**/identity*.ts' })).toBe('src/**/identity*.ts');
  });
  // Changed 2026-08-11: Read no longer derives a query at all — it was dropped
  // from the gated set after live friction. See the 'Read is not search intent'
  // block below.
  it('Read → null (not search intent)', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/x/y/runtime-selector.ts' })).toBeNull();
  });
  it('Bash with grep → the search terms', () => {
    expect(deriveQueryFromTool('Bash', { command: 'grep -rn "missing_api_key" src' })).toContain('missing_api_key');
  });
  it('Bash without search → null (not search intent)', () => {
    expect(deriveQueryFromTool('Bash', { command: 'npm run build' })).toBeNull();
  });
  it('non-search tool → null', () => {
    expect(deriveQueryFromTool('Edit', { file_path: '/a.ts' })).toBeNull();
  });
  it('malformed args → null, never throws', () => {
    expect(deriveQueryFromTool('Grep', null)).toBeNull();
    expect(deriveQueryFromTool('Grep', {})).toBeNull();
  });
});

// Regression pin: Bash search-shaping was ALREADY implemented before this
// amendment (query-derivation.ts BASH_SEARCH_PREFIX). The amended spec wrongly
// claimed it was missing. These tests pin it so it cannot silently regress into
// gating routine commands — the largest source of the July over-blocking.
describe('Bash search-shaping (regression pin)', () => {
  for (const cmd of ['grep -rn foo src/', 'rg foo', 'find . -name x', 'ag foo']) {
    it(`treats "${cmd}" as search intent`, () => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).not.toBeNull();
    });
  }
  for (const cmd of ['npm test', 'git status', 'bun run build', 'ls -la', 'npm run build-and-sync']) {
    it(`does NOT gate routine command "${cmd}"`, () => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).toBeNull();
    });
  }
});

// ── Read fully ungated (2026-08-11) ──────────────────────────────────────────
// Read was dropped from the gated set after live friction: cold reads of specs
// and source files are legitimately common during any investigation and are
// rarely why-questions, so gating them taxed normal work for little signal.
// Grep/Glob remain gated — they ARE search intent. This was also the fix
// direction recorded in the July over-blocking notes.
describe('Read is not search intent', () => {
  it('returns null for a cold Read', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/generation-health.ts' }, { warmPaths: new Set() })).toBeNull();
  });
  it('returns null for a Read with no warmPaths supplied', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/x.ts' })).toBeNull();
  });
  it('still gates Grep', () => {
    expect(deriveQueryFromTool('Grep', { pattern: 'ollama' })).not.toBeNull();
  });
  it('still gates Glob', () => {
    expect(deriveQueryFromTool('Glob', { pattern: 'src/**/x.ts' })).not.toBeNull();
  });
});

// ── Bash false positives (found LIVE 2026-08-11) ─────────────────────────────
// BASH_SEARCH_PREFIX was /(^|\s)(grep|rg|ag|find)\b/, which matches a search word
// ANYWHERE in the command. So a build or mutation-test script that merely piped
// through `grep -c X` in a later stage was classified as a discovery search and
// blocked. Found while running a mutation test: a
// `cp && perl && grep -c && bun test` command was gated. The search word must be
// the command being RUN, not any substring of a pipeline.
describe('Bash search detection anchors on the invoked command', () => {
  for (const cmd of [
    'cp a.ts /tmp/b.ts && perl -0pi -e "s/x/y/" a.ts && grep -c MUT a.ts && bun test x',
    'npm run build && grep -c foo dist/out.js',
    'git add -A && git commit -m "fix: grep handling"',
    'echo hi | grep hi',
  ]) {
    it(`does NOT gate: ${cmd.slice(0, 42)}`, () => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).toBeNull();
    });
  }
  for (const cmd of ['grep -rn foo src/', '  rg foo', 'find . -name x', 'ag foo']) {
    it(`still gates a real search: ${cmd.trim()}`, () => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).not.toBeNull();
    });
  }
});
