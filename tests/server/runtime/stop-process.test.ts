import { describe, expect, it } from 'bun:test';
import { stopProcess } from '../../../src/server/runtime/stop-process.js';

function fakeProcess(opts: { diesOn: NodeJS.Signals | null }) {
  let alive = true;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    deps: {
      kill: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === opts.diesOn || (opts.diesOn === 'SIGTERM' && signal === 'SIGKILL')) alive = false;
      },
      isAlive: () => alive,
      sleep: async () => {},
      termWaitMs: 50,
      killWaitMs: 50,
    },
  };
}

// The old stop waited 5s after SIGTERM, then printed "Server stopped" even when
// the process was still alive.
describe('stopProcess', () => {
  it('returns exited without escalating when SIGTERM is enough', async () => {
    const p = fakeProcess({ diesOn: 'SIGTERM' });
    expect(await stopProcess(123, p.deps)).toBe('exited');
    expect(p.signals).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const p = fakeProcess({ diesOn: 'SIGKILL' });
    expect(await stopProcess(123, p.deps)).toBe('exited');
    expect(p.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports survived when even SIGKILL does not end the process', async () => {
    const p = fakeProcess({ diesOn: null });
    expect(await stopProcess(123, p.deps)).toBe('survived');
  });
});
