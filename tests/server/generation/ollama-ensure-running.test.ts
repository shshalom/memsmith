// SPDX-License-Identifier: Apache-2.0
//
// Ollama died on a machine reboot and nothing restarted it. Generation stopped
// dead for ~15 hours while 6,958 jobs piled up, and nothing reported it.
//
// The health check added alongside this detects that within 15 minutes, but
// detection is not recovery — and 15 minutes of silence is still 15 minutes.
// Checking AT THE POINT OF USE is strictly better: the check happens exactly
// when a job needs ollama, so a dead provider is noticed immediately, restarted,
// and the work resumes. No timer to tune, no polling on an idle machine, no
// window where the outage is real but unreported.
//
// Two hazards this must not create, both of which would be worse than the bug:
//   - STAMPEDE: with concurrency 4, four jobs can each try to start ollama at
//     once. Single-flight, or you spawn four servers fighting for a port.
//   - HOT LOOP: if ollama cannot start at all, retrying on every single job
//     turns one broken install into a fork bomb. Backoff, and give up cleanly.
import { describe, it, expect } from 'bun:test';
import {
  ensureOllamaRunning,
  resolveAutostartEnabled,
  RESTART_BACKOFF_MS,
} from '../../../src/server/generation/providers/ollama-ensure-running.js';

function deps(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      probe: async () => { calls.push('probe'); return true; },
      spawn: async () => { calls.push('spawn'); },
      now: () => 1_000_000,
      ...over,
    } as never,
  };
}

describe('ensureOllamaRunning', () => {
  it('does nothing when ollama is already up', async () => {
    const { calls, d } = deps();
    expect(await ensureOllamaRunning(d)).toBe(true);
    expect(calls).toEqual(['probe']);
  });

  it('starts ollama when it is down, then confirms it came up', async () => {
    let up = false;
    const { calls, d } = deps({
      probe: async () => { calls.push('probe'); const r = up; up = true; return r; },
      spawn: async () => { calls.push('spawn'); },
    });
    expect(await ensureOllamaRunning(d)).toBe(true);
    // probe (down) -> spawn -> probe (up)
    expect(calls).toEqual(['probe', 'spawn', 'probe']);
  });

  it('reports failure when ollama will not come up', async () => {
    // Must return false rather than throw: the caller turns this into a
    // transient job failure so the work is retried, not lost.
    const { d } = deps({ probe: async () => false, spawn: async () => {} });
    expect(await ensureOllamaRunning(d)).toBe(false);
  });

  it('SINGLE-FLIGHTS concurrent callers so four jobs do not spawn four servers', async () => {
    let spawns = 0;
    let up = false;
    const d = {
      probe: async () => up,
      spawn: async () => { spawns += 1; await new Promise(r => setTimeout(r, 10)); up = true; },
      now: () => 1_000_000,
      state: {},
    } as never;
    await Promise.all([1, 2, 3, 4].map(() => ensureOllamaRunning(d)));
    expect(spawns).toBe(1);
  });

  it('BACKS OFF instead of respawning on every job when ollama is broken', async () => {
    // A permanently-broken install must not become a spawn loop.
    let spawns = 0;
    const state = {};
    const mk = (t: number) => ({
      probe: async () => false,
      spawn: async () => { spawns += 1; },
      now: () => t,
      state,
    }) as never;
    await ensureOllamaRunning(mk(1_000_000));
    await ensureOllamaRunning(mk(1_000_000 + 100));      // immediately after
    await ensureOllamaRunning(mk(1_000_000 + 1_000));    // still inside backoff
    expect(spawns).toBe(1);
    // ...and tries again only once the backoff has elapsed.
    await ensureOllamaRunning(mk(1_000_000 + RESTART_BACKOFF_MS + 1));
    expect(spawns).toBe(2);
  });

  it('never throws, whatever probe or spawn do', async () => {
    // This sits in the hot path of every generation call.
    expect(await ensureOllamaRunning(deps({ probe: async () => { throw new Error('x'); } }).d)).toBe(false);
    expect(await ensureOllamaRunning(deps({
      probe: async () => false,
      spawn: async () => { throw new Error('ENOENT: ollama not installed'); },
    }).d)).toBe(false);
  });

  it('does not spawn when autostart is disabled — only reports', async () => {
    // Spawning a process is a real side effect. It stays opt-outable.
    const { calls, d } = deps({ probe: async () => false, autostart: false });
    expect(await ensureOllamaRunning(d)).toBe(false);
    expect(calls).not.toContain('spawn');
  });
});

describe('resolveAutostartEnabled', () => {
  it('defaults to ON — a local provider that is down is always worth restarting', () => {
    expect(resolveAutostartEnabled({})).toBe(true);
  });

  it('can be turned off explicitly', () => {
    expect(resolveAutostartEnabled({ MEMSMITH_OLLAMA_AUTOSTART: 'false' })).toBe(false);
    expect(resolveAutostartEnabled({ MEMSMITH_OLLAMA_AUTOSTART: '0' })).toBe(false);
  });

  it('treats any other value as on', () => {
    expect(resolveAutostartEnabled({ MEMSMITH_OLLAMA_AUTOSTART: 'true' })).toBe(true);
    expect(resolveAutostartEnabled({ MEMSMITH_OLLAMA_AUTOSTART: 'yes' })).toBe(true);
  });
});
