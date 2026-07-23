import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { selectRuntime } from '../../../src/services/hooks/runtime-selector.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-rt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function marker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('selectRuntime(cwd) per-project', () => {
  it('marker runtime=server → server', () => {
    marker({ teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'http://x:1' });
    expect(selectRuntime(dir)).toBe('server');
  });
  it('marker with no runtime field → falls back to global (default local)', () => {
    marker({ teamId: 't', projectId: 'p' });
    expect(selectRuntime(dir)).toBe('local');
  });
  it('no marker at all → global default (local)', () => {
    expect(selectRuntime(dir)).toBe('local');
  });
  it('marker runtime=local → local (explicit)', () => {
    marker({ teamId: 't', projectId: 'p', runtime: 'local' });
    expect(selectRuntime(dir)).toBe('local');
  });
});
