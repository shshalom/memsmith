// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

const TMP = join(tmpdir(), 'memsmith-pg-lifecycle-test');

function fakeDriver() {
  const instance = {
    initialize: async () => {},
    start: async () => {},
    waitForReady: async () => {},
    getConnectionString: () => 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    stop: async () => {},
  };
  return { downloadBinaries: async () => {}, createServer: () => instance };
}

afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

describe('EmbeddedPostgresManager lifecycle', () => {
  it('start writes a pid file and returns a connection string', async () => {
    const mgr = new EmbeddedPostgresManager({
      driver: fakeDriver(),
      paths: { binariesDir: join(TMP, 'bin'), dataDir: join(TMP, 'data'), pidFile: join(TMP, 'pg.pid') },
    });
    const res = await mgr.start();
    expect(res.connectionString).toContain('postgres://');
    expect(res.reused).toBe(false);
    expect(existsSync(join(TMP, 'pg.pid'))).toBe(true);
  });

  it('second start with a live pid reuses instead of re-initializing', async () => {
    const paths = { binariesDir: join(TMP, 'bin'), dataDir: join(TMP, 'data'), pidFile: join(TMP, 'pg.pid') };
    const mgr1 = new EmbeddedPostgresManager({ driver: fakeDriver(), paths });
    await mgr1.start();
    // The pid file holds THIS test process's pid (alive), so a fresh manager should reuse.
    const mgr2 = new EmbeddedPostgresManager({ driver: fakeDriver(), paths });
    const res2 = await mgr2.start();
    expect(res2.reused).toBe(true);
  });

  it('start rejects when the configured port is already in use by another process', async () => {
    const port = 54321; // use a dedicated test port unlikely to conflict
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    try {
      const mgr = new EmbeddedPostgresManager({
        port,
        driver: fakeDriver(),
        paths: { binariesDir: join(TMP, 'bin'), dataDir: join(TMP, 'data'), pidFile: join(TMP, 'pg2.pid') },
      });
      await expect(mgr.start()).rejects.toThrow(/in use/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
