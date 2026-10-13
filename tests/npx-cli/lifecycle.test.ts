import { describe, expect, it } from 'bun:test';
import { resolveServerAddress, runLifecycle, type HealthResult, type LifecycleDeps } from '../../src/npx-cli/commands/lifecycle.js';

function deps(over: Partial<LifecycleDeps> & { health?: HealthResult[] } = {}) {
  const calls: { order: string[]; termWaits: (number | undefined)[]; scripts: string[][]; envs: Record<string, string>[]; stopped: number[]; out: string[]; err: string[]; pgStops: number; probes: number } =
    { order: [], termWaits: [], scripts: [], envs: [], stopped: [], out: [], err: [], pgStops: 0, probes: 0 };
  const health = over.health ?? [{ reachable: false }];
  let clock = 0;
  const d: LifecycleDeps = {
    runScript: async (args, env) => {
      calls.scripts.push(args);
      calls.order.push(args[0]);
      calls.envs.push(env);
      return { code: 0, stdout: args[0] === 'start' ? '{"status":"starting","pid":777,"port":38900}\n' : '' };
    },
    probeHealth: async () => { calls.probes++; return health.length > 1 ? health.shift()! : health[0]; },
    isAlive: () => true,
    stopProcess: async (pid, wait) => { calls.stopped.push(pid); calls.termWaits.push(wait); return 'exited'; },
    stopPostgres: async () => { calls.pgStops++; calls.order.push('postgres'); return 'stopped'; },
    postgresRunning: () => false,
    runtime: () => 'local',
    pluginVersion: () => '13.10.2',
    serverUrl: () => 'http://127.0.0.1:38900',
    logPath: () => '/tmp/memsmith.log',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    out: (l) => calls.out.push(l),
    err: (l) => calls.err.push(l),
    ...over,
  };
  return { d, calls };
}

const ready: HealthResult = { reachable: true, httpStatus: 200, initialized: true, version: '13.10.2', pid: 777, status: 'ok' };
const booting: HealthResult = { reachable: true, httpStatus: 200, initialized: false };

describe('resolveServerAddress', () => {
  it('treats loopback hosts as local and anything else as remote', () => {
    expect(resolveServerAddress('http://127.0.0.1:38879').remote).toBe(false);
    expect(resolveServerAddress('http://localhost:38879').remote).toBe(false);
    expect(resolveServerAddress('https://memsmith.example.com').remote).toBe(true);
  });
});

describe('start', () => {
  it('passes --daemon and the configured port to the server script', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.scripts[0]).toEqual(['start', '--daemon']);
    expect(calls.envs[0].MEMSMITH_SERVER_PORT).toBe('38900');
  });

  it('waits until the server reports initialized', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, booting, booting, ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.probes).toBe(4);
    expect(calls.stopped).toEqual([]);
  });

  it('counts a degraded but initialized server as started, with a warning', async () => {
    const degraded: HealthResult = { reachable: true, httpStatus: 503, initialized: true, status: 'degraded' };
    const { d, calls } = deps({ health: [{ reachable: false }, degraded] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.err.join('\n')).toContain('degraded');
  });

  it('kills the spawned daemon and exits 1 on timeout', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, booting] });
    expect(await runLifecycle('start', ['--timeout', '2'], d)).toBe(1);
    expect(calls.stopped).toEqual([777]);
    expect(calls.termWaits).toEqual([10_000]);
    expect(calls.err.join('\n')).toContain('/tmp/memsmith.log');
  });

  it('reports a daemon that survives the timeout kill', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, booting], stopProcess: async () => 'survived' });
    expect(await runLifecycle('start', ['--timeout', '2'], d)).toBe(1);
    const text = calls.err.join('\n');
    expect(text).toContain('still running (PID 777)');
    expect(text).not.toContain('was stopped');
  });

  it('kills nothing on timeout when the script reused an existing server', async () => {
    const { d, calls } = deps({
      health: [{ reachable: false }, booting],
      runScript: async () => ({ code: 0, stdout: '{"status":"ready","pid":555}\n' }),
    });
    expect(await runLifecycle('start', ['--timeout', '2'], d)).toBe(1);
    expect(calls.stopped).toEqual([]);
    expect(calls.err.join('\n')).toContain('PID is unknown');
  });

  it('kills nothing on timeout when the script reports no PID', async () => {
    const { d, calls } = deps({
      health: [{ reachable: false }, booting],
      runScript: async () => ({ code: 0, stdout: '' }),
    });
    expect(await runLifecycle('start', ['--timeout', '2'], d)).toBe(1);
    expect(calls.stopped).toEqual([]);
    expect(calls.err.join('\n')).toContain('PID is unknown');
  });

  it('fails fast when the daemon dies before becoming healthy', async () => {
    let probes = 0;
    const { d, calls } = deps({
      probeHealth: async () => { probes++; return { reachable: false }; },
      isAlive: () => false,
    });
    expect(await runLifecycle('start', [], d)).toBe(1);
    expect(probes).toBeLessThanOrEqual(2);
    expect(calls.err.join('\n')).toContain('exited during startup');
  });

  it('reuses a running server without spawning', async () => {
    const { d, calls } = deps({ health: [ready] });
    expect(await runLifecycle('start', [], d)).toBe(0);
    expect(calls.scripts).toEqual([]);
  });

  it('refuses to manage a remote server', async () => {
    const { d, calls } = deps({ serverUrl: () => 'https://team.example.com' });
    expect(await runLifecycle('start', [], d)).toBe(1);
    expect(calls.scripts).toEqual([]);
  });
});

describe('stop', () => {
  it('stops the server and leaves Postgres running by default', async () => {
    const { d, calls } = deps();
    expect(await runLifecycle('stop', [], d)).toBe(0);
    expect(calls.scripts[0]).toEqual(['stop']);
    expect(calls.pgStops).toBe(0);
  });

  it('also stops Postgres with --all, after the server', async () => {
    const { d, calls } = deps();
    expect(await runLifecycle('stop', ['--all'], d)).toBe(0);
    expect(calls.order).toEqual(['stop', 'postgres']);
    expect(calls.pgStops).toBe(1);
  });

  it('fails when the port still answers after stop', async () => {
    const { d } = deps({ health: [ready] });
    expect(await runLifecycle('stop', [], d)).toBe(1);
  });

  it('fails --all when Postgres survives', async () => {
    const { d } = deps({ stopPostgres: async () => 'survived' });
    expect(await runLifecycle('stop', ['--all'], d)).toBe(1);
  });
});

describe('restart', () => {
  it('stops the server before starting it', async () => {
    const { d, calls } = deps({ health: [{ reachable: false }, { reachable: false }, ready] });
    expect(await runLifecycle('restart', [], d)).toBe(0);
    expect(calls.order).toEqual(['stop', 'start']);
  });

  it('does not start when stop fails', async () => {
    const { d, calls } = deps({
      runScript: async (args) => { calls.order.push(args[0]); return { code: 1, stdout: '' }; },
    });
    expect(await runLifecycle('restart', [], d)).toBe(1);
    expect(calls.order).toEqual(['stop']);
  });
});

describe('status', () => {
  it('exits 1 when nothing answers', async () => {
    const { d } = deps();
    expect(await runLifecycle('status', [], d)).toBe(1);
  });

  it('exits 0 and prints the server and plugin versions when running', async () => {
    const { d, calls } = deps({ health: [{ ...ready, version: '13.10.1' }] });
    expect(await runLifecycle('status', [], d)).toBe(0);
    const text = calls.out.join('\n');
    expect(text).toContain('13.10.1');
    expect(text).toContain('13.10.2');
    expect(text).toContain('http://127.0.0.1:38900');
  });
});
