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

/** A machine holding a key for these teams, and no others. */
const holdsKeysFor = (...teams: string[]) => (teamId: string) => teams.includes(teamId);
/** A fresh clone: no credentials for anything. */
const holdsNoKeys = () => false;

describe('selectRuntime(cwd) per-project', () => {
  it('marker runtime=server AND a key for that team → server', () => {
    marker({ teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'http://x:1' });
    expect(selectRuntime(dir, holdsKeysFor('t'))).toBe('server');
  });

  it('marker runtime=server but NO key → local (tracked, not joined)', () => {
    // The fresh-clone regression. This assertion previously read `server`,
    // which is the bug: the marker ships in the repo but the key does not, so a
    // teammate's first checkout entered server mode with no credential and every
    // hook dropped its observations via `missing_api_key`. Capture must stay
    // local until the user actually joins.
    marker({ teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'http://x:1' });
    expect(selectRuntime(dir, holdsNoKeys)).toBe('local');
  });

  it('marker runtime=server with a key for a DIFFERENT team → local', () => {
    // A joiner already works on their own projects, so their credential store is
    // not empty. Holding some key must not be mistaken for holding THIS one.
    marker({ teamId: 'team-a', projectId: 'p', runtime: 'server', serverUrl: 'http://x:1' });
    expect(selectRuntime(dir, holdsKeysFor('other-team'))).toBe('local');
  });

  it('a keyless team marker stays local even if the global setting says server', () => {
    // The gate must not fall through to MEMSMITH_RUNTIME for a tracked project —
    // that would reopen the silent-drop path via the global default.
    marker({ teamId: 't', projectId: 'p', runtime: 'server' });
    const prior = process.env.MEMSMITH_RUNTIME;
    process.env.MEMSMITH_RUNTIME = 'server';
    try {
      expect(selectRuntime(dir, holdsNoKeys)).toBe('local');
    } finally {
      if (prior === undefined) delete process.env.MEMSMITH_RUNTIME;
      else process.env.MEMSMITH_RUNTIME = prior;
    }
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
