// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { startLocalRuntime } from '../../src/server/runtime/local-runtime.js';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeManager(conn: string): EmbeddedPostgresManager {
  return { start: async () => ({ connectionString: conn, reused: false }), getConnectionString: () => conn, stop: async () => {}, isRunning: () => false } as unknown as EmbeddedPostgresManager;
}

describe('startLocalRuntime import hook', () => {
  it('runs the import before starting the service', async () => {
    const order: string[] = [];
    await startLocalRuntime({
      manager: fakeManager('postgres://x:y@127.0.0.1:55433/postgres'),
      runImport: async () => { order.push('import'); },
      startService: async () => { order.push('service'); },
    });
    expect(order).toEqual(['import', 'service']);
  });

  it('an import failure does not block service start', async () => {
    const order: string[] = [];
    await startLocalRuntime({
      manager: fakeManager('postgres://x:y@127.0.0.1:55433/postgres'),
      runImport: async () => { throw new Error('import boom'); },
      startService: async () => { order.push('service'); },
    });
    expect(order).toEqual(['service']);
  });
});
