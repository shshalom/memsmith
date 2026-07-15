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
