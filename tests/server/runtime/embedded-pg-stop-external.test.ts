import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EmbeddedPostgresManager } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

function setup(opts: { pmDataDir?: string; pmPort?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'ms-pg-'));
  const dataDir = join(root, 'pgdata');
  const pidFile = join(root, 'local-pg.pid');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pidFile, '4242');
  writeFileSync(
    join(dataDir, 'postmaster.pid'),
    ['4242', opts.pmDataDir ?? dataDir, '1700000000', String(opts.pmPort ?? 55999), '/tmp', '127.0.0.1'].join('\n'),
  );
  const manager = new EmbeddedPostgresManager({ paths: { dataDir, pidFile, binariesDir: join(root, 'bin') }, port: 55999 });
  return { manager, pidFile };
}

function fakeProc(diesOn: NodeJS.Signals | null, startAlive = true) {
  let alive = startAlive;
  const signals: NodeJS.Signals[] = [];
  return {
    signals,
    deps: {
      kill: (_p: number, s: NodeJS.Signals) => { signals.push(s); if (s === diesOn) alive = false; },
      isAlive: () => alive,
      sleep: async () => {},
      phaseWaitMs: 50,
    },
  };
}

// The old cross-process stop only deleted local-pg.pid, leaving postgres on the
// port; the next start then refused the port as foreign.
describe('EmbeddedPostgresManager.stopExternal', () => {
  it('signals postgres and removes local-pg.pid only after it exits', async () => {
    const { manager, pidFile } = setup({});
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('stopped');
    expect(p.signals).toEqual(['SIGTERM']);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('falls back to a fast shutdown when smart shutdown stalls', async () => {
    const { manager } = setup({});
    const p = fakeProc('SIGINT');
    expect(await manager.stopExternal(p.deps)).toBe('stopped');
    expect(p.signals).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('keeps local-pg.pid when postgres never exits', async () => {
    const { manager, pidFile } = setup({});
    expect(await manager.stopExternal(fakeProc(null).deps)).toBe('survived');
    expect(existsSync(pidFile)).toBe(true);
  });

  it('sends no signal to a postgres serving another data directory', async () => {
    const { manager } = setup({ pmDataDir: '/somewhere/else' });
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('foreign');
    expect(p.signals).toEqual([]);
  });

  it('sends no signal to a postgres on another port', async () => {
    const { manager } = setup({ pmPort: 55433 });
    const p = fakeProc('SIGTERM');
    expect(await manager.stopExternal(p.deps)).toBe('foreign');
    expect(p.signals).toEqual([]);
  });

  it('cleans up a dead postmaster without signalling', async () => {
    const { manager, pidFile } = setup({});
    const p = fakeProc(null, false);
    expect(await manager.stopExternal(p.deps)).toBe('not-running');
    expect(p.signals).toEqual([]);
    expect(existsSync(pidFile)).toBe(false);
  });
});
