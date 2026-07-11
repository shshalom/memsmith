// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
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
    const mgr = new EmbeddedPostgresManager({ driver, paths: { binariesDir: '/tmp/does-not-exist-memsmith-test' } });
    await mgr.ensureBinary();
    expect(calls).toContain('download');
  });

  it('getConnectionString throws before start', () => {
    const { driver } = fakeDriver();
    const mgr = new EmbeddedPostgresManager({ driver });
    expect(() => mgr.getConnectionString()).toThrow(/not started/i);
  });
});
