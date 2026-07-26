// tests/services/hooks/two-project-isolation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { selectRuntime } from '../../../src/services/hooks/runtime-selector.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ms-2proj-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function proj(name: string, m: Record<string, unknown>) {
  const d = join(root, name);
  mkdirSync(join(d, '.memsmith'), { recursive: true });
  writeFileSync(join(d, '.memsmith', 'project.json'), JSON.stringify({ teamId: name, projectId: name, ...m }), 'utf-8');
  return d;
}

describe('two projects on one machine resolve independently', () => {
  it('A (no runtime) → local, B (runtime server) → server', () => {
    const a = proj('A', {});
    const b = proj('B', { runtime: 'server', serverUrl: 'http://b:1' });
    expect(selectRuntime(a)).toBe('local');
    expect(selectRuntime(b)).toBe('server');
  });
});
