import { describe, it, expect } from 'bun:test';
import { deriveQueryFromTool } from '../../src/services/retrieval/query-derivation.js';

describe('deriveQueryFromTool', () => {
  it('Grep → the pattern', () => {
    expect(deriveQueryFromTool('Grep', { pattern: 'buildServerContext' })).toBe('buildServerContext');
  });
  it('Glob → the glob pattern', () => {
    expect(deriveQueryFromTool('Glob', { pattern: 'src/**/identity*.ts' })).toBe('src/**/identity*.ts');
  });
  it('Read → basename + dir terms of the file path', () => {
    const q = deriveQueryFromTool('Read', { file_path: '/x/y/runtime-selector.ts' });
    expect(q).toContain('runtime-selector');
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

// ── Amendment 1 (2026-08-11): Read is gated to COLD reads only ───────────────
describe('Amendment 1 — Read gating', () => {
  it('derives a query for a COLD read', () => {
    const q = deriveQueryFromTool('Read', { file_path: '/a/generation-health.ts' }, { warmPaths: new Set() });
    expect(q).toContain('generation-health');
  });

  it('returns null for a WARM read — re-reading is not seeking information', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/generation-health.ts' },
      { warmPaths: new Set(['/a/generation-health.ts']) })).toBeNull();
  });

  it('gates a DIFFERENT file even when another is warm', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/other.ts' },
      { warmPaths: new Set(['/a/generation-health.ts']) })).not.toBeNull();
  });

  it('is unchanged when warmPaths is omitted (back-compat)', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/x.ts' })).not.toBeNull();
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
