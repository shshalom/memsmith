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

/** proj() names each project's team after itself, so a key set is a team-name set. */
const holdsKeysFor = (...teams: string[]) => (teamId: string) => teams.includes(teamId);

describe('two projects on one machine resolve independently', () => {
  it('A (no runtime) → local, B (runtime server, joined) → server', () => {
    const a = proj('A', {});
    const b = proj('B', { runtime: 'server', serverUrl: 'http://b:1' });
    // B is JOINED: its marker says server and this machine holds B's key.
    // The key must be injected rather than left to the ambient credential
    // store — otherwise the assertion passes or fails depending on what the
    // developer running the suite happens to have in ~/.memsmith.
    expect(selectRuntime(a, holdsKeysFor('B'))).toBe('local');
    expect(selectRuntime(b, holdsKeysFor('B'))).toBe('server');
  });

  it('isolates the KEY too: B joined does not pull tracked C into server mode', () => {
    // The isolation property this file is named for, extended to the credential.
    // One machine can be joined to one team project and merely tracking another;
    // resolving C by "some key exists" rather than "C's key exists" would flip C
    // into server mode with no usable credential and silently drop its capture.
    const b = proj('B', { runtime: 'server', serverUrl: 'http://b:1' });
    const c = proj('C', { runtime: 'server', serverUrl: 'http://c:1' });
    expect(selectRuntime(b, holdsKeysFor('B'))).toBe('server');
    expect(selectRuntime(c, holdsKeysFor('B'))).toBe('local');
  });
});
