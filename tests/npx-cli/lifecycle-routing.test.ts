import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { routeLifecycle } from '../../src/npx-cli/commands/server.js';
import { serverApiKeyArgs } from '../../src/npx-cli/commands/runtime.js';
import type { LifecycleDeps } from '../../src/npx-cli/commands/lifecycle.js';

function recorder(scriptCode = 0, serverUp = false) {
  const scripts: string[][] = [];
  const calls: string[] = [];
  const outs: string[] = [];
  const errs: string[] = [];
  const d = {
    runScript: async (args: string[]) => { calls.push('runScript'); scripts.push(args); return { code: scriptCode, stdout: '{"pid":1,"status":"starting"}' }; },
    probeHealth: async () => (serverUp || scripts.some((a) => a[0] === 'start') ? { reachable: true, httpStatus: 200, initialized: true } : { reachable: false }),
    isAlive: () => true,
    stopProcess: async () => { calls.push('stopProcess'); return 'exited'; },
    stopPostgres: async () => { calls.push('stopPostgres'); return 'stopped'; },
    postgresRunning: () => false,
    runtime: () => 'local',
    pluginVersion: () => '0',
    serverUrl: () => 'http://127.0.0.1:38900',
    logPath: () => '/tmp/log',
    sleep: async () => {},
    now: () => 0,
    out: (l: string) => { outs.push(l); },
    err: (l: string) => { errs.push(l); },
  } as unknown as LifecycleDeps;
  return { d, scripts, calls, outs, errs };
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

  it('top start resolves 0 and a failing runScript yields non-zero', async () => {
    expect(await routeLifecycle('top', ['start'], recorder().d)).toBe(0);
    expect(await routeLifecycle('top', ['start'], recorder(1).d)).not.toBe(0);
  });

  for (const ns of ['top', 'server', 'worker'] as const) {
    it(`${ns} restart stops then starts the daemon`, async () => {
      const { d, scripts } = recorder();
      await routeLifecycle(ns, ['restart'], d);
      expect(scripts.map((s) => s[0])).toEqual(['stop', 'start']);
    });

    it(`${ns} status reports without running the server script`, async () => {
      const { d, scripts, outs } = recorder(0, true);
      expect(await routeLifecycle(ns, ['status'], d)).toBe(0);
      expect(scripts).toEqual([]);
      expect(outs[0]).toBe('Server is running');
    });
  }

  describe('worker deprecation notice', () => {
    afterEach(() => { spy?.mockRestore(); });
    let spy: ReturnType<typeof spyOn> | undefined;

    for (const [ns, warns] of [['worker', true], ['top', false], ['server', false]] as const) {
      it(`${ns} ${warns ? 'prints' : 'does not print'} the deprecation warning`, async () => {
        spy = spyOn(console, 'error').mockImplementation(() => {});
        await routeLifecycle(ns, ['status'], recorder().d);
        const printed = spy.mock.calls.some((c) => String(c[0]).includes('deprecated'));
        expect(printed).toBe(warns);
      });
    }
  });

  describe('help and unknown flags', () => {
    for (const cmd of ['start', 'stop', 'restart', 'status'] as const) {
      for (const flag of ['--help', '-h']) {
        it(`${cmd} ${flag} prints usage and touches nothing`, async () => {
          const { d, calls, outs } = recorder();
          expect(await routeLifecycle('top', [cmd, flag], d)).toBe(0);
          expect(calls).toEqual([]);
          expect(outs[0]).toStartWith(`Usage: memsmith ${cmd}`);
        });
      }
    }

    it('stop --bogus returns 1 with no side effects', async () => {
      const { d, calls, errs } = recorder();
      expect(await routeLifecycle('server', ['stop', '--bogus'], d)).toBe(1);
      expect(calls).toEqual([]);
      expect(errs[0]).toBe('Unknown option: --bogus');
    });

    it('status rejects --all', async () => {
      const { d, calls } = recorder();
      expect(await routeLifecycle('top', ['status', '--all'], d)).toBe(1);
      expect(calls).toEqual([]);
    });

    it('stop --all still stops Postgres', async () => {
      const { d, calls } = recorder();
      expect(await routeLifecycle('top', ['stop', '--all'], d)).toBe(0);
      expect(calls).toEqual(['runScript', 'stopPostgres']);
    });

    it('start --timeout 5 is accepted', async () => {
      const { d, scripts } = recorder();
      await routeLifecycle('top', ['start', '--timeout', '5'], d);
      expect(scripts[0]).toEqual(['start', '--daemon']);
    });
  });
});
