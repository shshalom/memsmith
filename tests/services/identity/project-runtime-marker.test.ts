// tests/services/identity/project-runtime-marker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeProjectRuntime, readProjectMarker } from '../../../src/services/identity/project-identity.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-marker-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function seedMarker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('project runtime marker', () => {
  it('writeProjectRuntime merges runtime fields, preserving identity + note', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'keep me' });
    writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://team.example:38890' });
    const m = readProjectMarker(dir)!;
    expect(m.teamId).toBe('t1');
    expect(m.projectId).toBe('p1');
    expect(m.note).toBe('keep me');
    expect(m.runtime).toBe('server');
    expect(m.serverUrl).toBe('http://team.example:38890');
  });
  it('never writes a key/secret field into the marker', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'n' });
    writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://x:1' });
    const raw = readFileSync(join(dir, '.memsmith', 'project.json'), 'utf-8').toLowerCase();
    expect(raw.includes('key')).toBe(false);
    expect(raw.includes('secret')).toBe(false);
    expect(raw.includes('cmem_')).toBe(false);
  });
  it('readProjectMarker returns runtime/serverUrl when present, undefined when absent', () => {
    seedMarker({ teamId: 't1', projectId: 'p1', note: 'n', runtime: 'server', serverUrl: 'http://x:1' });
    const m = readProjectMarker(dir)!;
    expect(m.runtime).toBe('server');
    seedMarker({ teamId: 't2', projectId: 'p2', note: 'n' });
    const m2 = readProjectMarker(dir)!;
    expect(m2.runtime).toBeUndefined();
    expect(m2.serverUrl).toBeUndefined();
  });
  it('writeProjectRuntime on a missing marker is a no-op-safe error (does not create a partial identity-less marker)', () => {
    // No marker seeded.
    expect(() => writeProjectRuntime(dir, { runtime: 'server', serverUrl: 'http://x:1' })).toThrow();
  });
});
