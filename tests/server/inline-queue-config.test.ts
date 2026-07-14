// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { validateServerEnv } from '../../src/server/runtime/create-server-service.js';

const base = {
  MEMSMITH_SERVER_DATABASE_URL: 'postgres://x:y@127.0.0.1:55433/postgres',
  MEMSMITH_RUNTIME: 'local',
};

describe('inline queue engine', () => {
  it('is allowed outside Docker', () => {
    expect(() => validateServerEnv({ isDocker: false, env: { ...base, MEMSMITH_QUEUE_ENGINE: 'inline' } as any }))
      .not.toThrow();
  });
  it('is rejected inside Docker', () => {
    expect(() => validateServerEnv({ isDocker: true, env: { ...base, MEMSMITH_RUNTIME: 'server', MEMSMITH_QUEUE_ENGINE: 'inline', MEMSMITH_REDIS_URL: 'redis://x' } as any }))
      .toThrow(/only "bullmq" is supported/i);
  });
});
