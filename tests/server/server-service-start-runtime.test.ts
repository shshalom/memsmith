import { describe, it, expect } from 'bun:test';
import { runRuntimeForeground } from '../../src/server/runtime/ServerService.js';

describe('runRuntimeForeground runtime branch', () => {
  it('boots local when selectRuntime returns local', async () => {
    const calls: string[] = [];
    await runRuntimeForeground(0, '127.0.0.1', {
      selectRuntime: () => 'local',
      startLocal: async () => { calls.push('local'); },
      startServer: async () => { calls.push('server'); },
    });
    expect(calls).toEqual(['local']);
  });

  // Task 6 — a teammate's LAPTOP in team mode must start the local generation
  // loop, NOT a full server: createServerService hard-requires
  // MEMSMITH_SERVER_DATABASE_URL/MEMSMITH_REDIS_URL, which a laptop does not
  // have. That failure is the bug this task exists to fix.
  it('team mode on a laptop (no database URL) starts the generation loop', async () => {
    const prev = process.env.MEMSMITH_SERVER_DATABASE_URL;
    delete process.env.MEMSMITH_SERVER_DATABASE_URL;
    try {
      const calls: string[] = [];
      await runRuntimeForeground(1, 'h', {
        selectRuntime: () => 'server',
        startServer: async () => { calls.push('server'); },
        startGenerationLoop: async () => { calls.push('loop'); },
      } as never);
      expect(calls).toEqual(['loop']);
    } finally {
      if (prev === undefined) delete process.env.MEMSMITH_SERVER_DATABASE_URL;
      else process.env.MEMSMITH_SERVER_DATABASE_URL = prev;
    }
  });

  // REGRESSION GUARD (controller-added after the first Task 6 attempt broke
  // this). A REAL server — AWS Fargate, systemd — also resolves selectRuntime
  // to 'server', but it HAS a database URL and must run the HTTP server. The
  // container entrypoint reaches runRuntimeForeground via `--daemon`, so
  // routing it to the generation loop would leave the deployed stack with no
  // HTTP listener at all. Verified against the live task definition
  // (memsmith:6), which sets MEMSMITH_RUNTIME=server-beta -> 'server'.
  it('a REAL server (database URL present) still starts the HTTP server', async () => {
    const prev = process.env.MEMSMITH_SERVER_DATABASE_URL;
    process.env.MEMSMITH_SERVER_DATABASE_URL = 'postgres://u:p@db.example.com:5432/memsmith';
    try {
      const calls: string[] = [];
      await runRuntimeForeground(1, 'h', {
        selectRuntime: () => 'server',
        startServer: async () => { calls.push('server'); },
        startGenerationLoop: async () => { calls.push('loop'); },
      } as never);
      expect(calls).toEqual(['server']);
    } finally {
      if (prev === undefined) delete process.env.MEMSMITH_SERVER_DATABASE_URL;
      else process.env.MEMSMITH_SERVER_DATABASE_URL = prev;
    }
  });

  it('local mode is unchanged (startGenerationLoop present but unused)', async () => {
    const calls: string[] = [];
    await runRuntimeForeground(1, 'h', {
      selectRuntime: () => 'local',
      startLocal: async () => { calls.push('local'); },
      startServer: async () => { calls.push('server'); },
      startGenerationLoop: async () => { calls.push('loop'); },
    } as never);
    expect(calls).toEqual(['local']);
  });
});
