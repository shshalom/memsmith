// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeDriver() {
  const calls: string[] = [];
  const instance = {
    initialize: async () => { calls.push('initialize'); },
    start: async () => { calls.push('start'); },
    waitForReady: async () => { calls.push('waitForReady'); },
    getConnectionString: () => 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    stop: async () => { calls.push('stop'); },
  };
  const driver = {
    downloadBinaries: async () => { calls.push('download'); },
    createServer: () => instance,
  };
  return { driver, instance, calls };
}

describe('EmbeddedPostgresManager', () => {
  it('ensureBinary downloads once', async () => {
    const { driver, calls } = fakeDriver();
    // Use a fresh, guaranteed-absent temp path with cleanup so the download
    // precondition (binariesDir does not yet exist) holds regardless of prior
    // runs. A hardcoded shared path flakes once any run creates it.
    const binariesDir = join(tmpdir(), `memsmith-test-pg-download-${process.pid}`);
    rmSync(binariesDir, { recursive: true, force: true });
    try {
      const mgr = new EmbeddedPostgresManager({ driver, paths: { binariesDir } });
      await mgr.ensureBinary();
      expect(calls).toContain('download');
    } finally {
      rmSync(binariesDir, { recursive: true, force: true });
    }
  });

  it('getConnectionString throws before start', () => {
    const { driver } = fakeDriver();
    const mgr = new EmbeddedPostgresManager({ driver });
    expect(() => mgr.getConnectionString()).toThrow(/not started/i);
  });

  describe('ensureBinary cleanup on download failure', () => {
    let testBinariesDir: string;

    afterEach(() => {
      if (testBinariesDir && existsSync(testBinariesDir)) {
        rmSync(testBinariesDir, { recursive: true, force: true });
      }
    });

    it('removes binariesDir when downloadBinaries rejects', async () => {
      testBinariesDir = join(tmpdir(), `memsmith-test-pg-bins-${Date.now()}`);
      const failingDriver = {
        downloadBinaries: async () => { throw new Error('network failure'); },
        createServer: () => { throw new Error('should not be called'); },
      };
      const mgr = new EmbeddedPostgresManager({
        driver: failingDriver,
        paths: { binariesDir: testBinariesDir },
      });
      await expect(mgr.ensureBinary()).rejects.toThrow(/Failed to download embedded Postgres binaries/);
      expect(existsSync(testBinariesDir)).toBe(false);
    });
  });
});
