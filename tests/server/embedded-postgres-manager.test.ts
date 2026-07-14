// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'fs';
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
    // A real download populates the `bin/` subdir. Mirror that so ensureBinary's
    // completion check (a populated dir, not merely an existing dir) is exercised.
    downloadBinaries: async (opts: { targetDir: string }) => {
      calls.push('download');
      mkdirSync(join(opts.targetDir, 'bin'), { recursive: true });
    },
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

  it('re-downloads when the binaries dir exists but is empty (partial/interrupted download)', async () => {
    // A SIGKILL mid-download leaves binariesDir present but without `bin/`.
    // A plain existsSync(dir) skip would then wedge every later start with a
    // confusing failure deep in createServer. ensureBinary must treat an
    // unpopulated dir as absent and re-download.
    const { driver, calls } = fakeDriver();
    const binariesDir = join(tmpdir(), `memsmith-test-pg-partial-${process.pid}`);
    rmSync(binariesDir, { recursive: true, force: true });
    mkdirSync(binariesDir, { recursive: true }); // dir exists, but empty — no bin/
    try {
      const mgr = new EmbeddedPostgresManager({ driver, paths: { binariesDir } });
      await mgr.ensureBinary();
      expect(calls).toContain('download');
      expect(existsSync(join(binariesDir, 'bin'))).toBe(true);
    } finally {
      rmSync(binariesDir, { recursive: true, force: true });
    }
  });

  it('does NOT re-download when the binaries dir is already populated', async () => {
    const { driver, calls } = fakeDriver();
    const binariesDir = join(tmpdir(), `memsmith-test-pg-populated-${process.pid}`);
    rmSync(binariesDir, { recursive: true, force: true });
    mkdirSync(join(binariesDir, 'bin'), { recursive: true }); // already complete
    try {
      const mgr = new EmbeddedPostgresManager({ driver, paths: { binariesDir } });
      await mgr.ensureBinary();
      expect(calls).not.toContain('download');
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
