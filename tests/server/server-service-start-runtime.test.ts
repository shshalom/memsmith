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

  it('boots server when selectRuntime returns server', async () => {
    const calls: string[] = [];
    await runRuntimeForeground(0, '127.0.0.1', {
      selectRuntime: () => 'server',
      startLocal: async () => { calls.push('local'); },
      startServer: async () => { calls.push('server'); },
    });
    expect(calls).toEqual(['server']);
  });
});
