import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readServerPidFile, removeServerState } from '../../../src/server/runtime/server-state.js';

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-state-'));
  return { pid: join(dir, 'pid'), port: join(dir, 'port'), runtime: join(dir, 'runtime.json') };
}

describe('server-state', () => {
  it('removes all three state files', () => {
    const f = files();
    for (const p of Object.values(f)) writeFileSync(p, '{}');
    removeServerState(f);
    expect(Object.values(f).some(existsSync)).toBe(false);
  });

  it('returns null for a corrupt pid file instead of throwing', () => {
    const f = files();
    writeFileSync(f.pid, 'not json');
    expect(readServerPidFile(f)).toBeNull();
  });
});
