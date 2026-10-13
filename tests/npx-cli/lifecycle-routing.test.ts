import { describe, expect, it } from 'bun:test';
import { routeLifecycle } from '../../src/npx-cli/commands/server.js';
import { serverApiKeyArgs } from '../../src/npx-cli/commands/runtime.js';
import type { LifecycleDeps } from '../../src/npx-cli/commands/lifecycle.js';

function recorder() {
  const scripts: string[][] = [];
  const d = {
    runScript: async (args: string[]) => { scripts.push(args); return { code: 0, stdout: '{"pid":1,"status":"starting"}' }; },
    probeHealth: async () => (scripts.length ? { reachable: true, httpStatus: 200, initialized: true } : { reachable: false }),
    isAlive: () => true,
    stopProcess: async () => 'exited',
    stopPostgres: async () => 'stopped',
    postgresRunning: () => false,
    runtime: () => 'local',
    pluginVersion: () => '0',
    serverUrl: () => 'http://127.0.0.1:38900',
    logPath: () => '/tmp/log',
    sleep: async () => {},
    now: () => 0,
    out: () => {},
    err: () => {},
  } as unknown as LifecycleDeps;
  return { d, scripts };
}

// Observed 2026-10-13: `memsmith stop` and `memsmith worker stop` called the
// removed worker-service.cjs, and `server start` ran without --daemon.
describe('lifecycle routing', () => {
  for (const ns of ['top', 'server', 'worker'] as const) {
    it(`${ns} start runs server-service start --daemon`, async () => {
      const { d, scripts } = recorder();
      await routeLifecycle(ns, ['start'], d);
      expect(scripts[0]).toEqual(['start', '--daemon']);
    });

    it(`${ns} stop runs server-service stop`, async () => {
      const { d, scripts } = recorder();
      await routeLifecycle(ns, ['stop'], d);
      expect(scripts[0]).toEqual(['stop']);
    });
  }

  it('returns null for a non-lifecycle subcommand so the caller can handle it', async () => {
    const { d } = recorder();
    expect(await routeLifecycle('server', ['api-key'], d)).toBeNull();
  });

  it('server api-key list keeps the server prefix that server-service dispatches on', () => {
    expect(serverApiKeyArgs(['list'])).toEqual(['server', 'api-key', 'list']);
  });
});
