// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { startLocalRuntime } from '../../src/server/runtime/local-runtime.js';
import { EmbeddedPostgresManager } from '../../src/server/runtime/EmbeddedPostgresManager.js';

function fakeManager(conn: string): EmbeddedPostgresManager {
  return {
    start: async () => ({ connectionString: conn, reused: false }),
    getConnectionString: () => conn,
    stop: async () => {},
    isRunning: () => false,
  } as unknown as EmbeddedPostgresManager;
}

describe('startLocalRuntime', () => {
  it('sets DATABASE_URL + inline engine and calls the service starter', async () => {
    const conn = 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres';
    delete process.env.MEMSMITH_QUEUE_ENGINE;
    let startedWith: string | null = null;
    await startLocalRuntime({ manager: fakeManager(conn), startService: async (c) => { startedWith = c; } });
    expect(startedWith).toBe(conn);
    expect(process.env.MEMSMITH_SERVER_DATABASE_URL).toBe(conn);
    expect(process.env.MEMSMITH_QUEUE_ENGINE).toBe('inline');
  });

  it('does not override an explicitly set queue engine', async () => {
    process.env.MEMSMITH_QUEUE_ENGINE = 'bullmq';
    const conn = 'postgres://x:y@127.0.0.1:55433/postgres';
    await startLocalRuntime({ manager: fakeManager(conn), startService: async () => {} });
    expect(process.env.MEMSMITH_QUEUE_ENGINE).toBe('bullmq');
    delete process.env.MEMSMITH_QUEUE_ENGINE;
  });
});
