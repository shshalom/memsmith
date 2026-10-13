import { existsSync } from 'fs';
import { join } from 'path';
import { parseArgs, styleText } from 'node:util';
import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { getBunPath } from '../install/setup-runtime.js';
import { EmbeddedPostgresManager } from '../../server/runtime/EmbeddedPostgresManager.js';
import { selectRuntime } from '../../services/hooks/runtime-selector.js';
import { isPluginInstalled, marketplaceDirectory, installedPluginVersion } from '../utils/paths.js';

export type LifecycleCommand = 'start' | 'stop' | 'restart' | 'status';

export type HealthResult =
  | { reachable: false }
  | { reachable: true; httpStatus: number; initialized: boolean; version?: string; pid?: number; status?: string };

export interface LifecycleDeps {
  runScript(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string }>;
  probeHealth(baseUrl: string): Promise<HealthResult>;
  isAlive(pid: number): boolean;
  stopProcess(pid: number, termWaitMs?: number): Promise<'exited' | 'survived'>;
  stopPostgres(): Promise<'not-running' | 'stopped' | 'foreign' | 'survived'>;
  postgresRunning(): boolean;
  runtime(): 'local' | 'server';
  pluginVersion(): string;
  serverUrl(): string;
  logPath(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
  out(line: string): void;
  err(line: string): void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const POLL_MS = 500;
const DEFAULT_TIMEOUT_S = 300;

export function resolveServerAddress(url: string): { host: string; port: number; baseUrl: string; remote: boolean } {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return {
    host: parsed.hostname,
    port,
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    remote: !LOOPBACK.has(parsed.hostname),
  };
}

function parseSpawnedPid(stdout: string): number | null {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line) as { pid?: unknown; status?: unknown };
      if (typeof parsed.pid === 'number') return parsed.status === 'starting' ? parsed.pid : null;
    } catch { /* not the JSON line */ }
  }
  return null;
}

const START_KILL_TERM_WAIT_MS = 10_000;

async function start(argv: string[], d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { timeout: { type: 'string' } }, strict: false });
  const timeoutS = Number(values.timeout ?? DEFAULT_TIMEOUT_S);

  const existing = await d.probeHealth(addr.baseUrl);
  if (existing.reachable) {
    d.out(`Server is already running at ${addr.baseUrl}`);
    return 0;
  }

  const result = await d.runScript(['start', '--daemon'], { MEMSMITH_SERVER_PORT: String(addr.port) });
  if (result.code !== 0) {
    d.err(`Server failed to start. Log: ${d.logPath()}`);
    return 1;
  }
  const pid = parseSpawnedPid(result.stdout);

  const deadline = d.now() + timeoutS * 1000;
  while (d.now() < deadline) {
    const health = await d.probeHealth(addr.baseUrl);
    if (health.reachable && health.initialized) {
      if (health.httpStatus === 503) d.err(`Server started but reports degraded: ${health.status ?? 'unknown'}`);
      d.out(`Server is running at ${addr.baseUrl}`);
      return 0;
    }
    if (pid !== null && !d.isAlive(pid)) {
      d.err(`Server exited during startup. Log: ${d.logPath()}`);
      return 1;
    }
    await d.sleep(POLL_MS);
  }

  const timedOut = `Server did not become ready within ${timeoutS}s`;
  if (pid === null) {
    d.err(`${timedOut}. The daemon PID is unknown, so nothing was stopped. Log: ${d.logPath()}`);
  } else if ((await d.stopProcess(pid, START_KILL_TERM_WAIT_MS)) === 'survived') {
    d.err(`${timedOut}. The daemon is still running (PID ${pid}); kill it manually. Log: ${d.logPath()}`);
  } else {
    d.err(`${timedOut} and was stopped. Log: ${d.logPath()}`);
  }
  return 1;
}

async function stop(argv: string[], d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const all = argv.includes('--all');
  const result = await d.runScript(['stop'], { MEMSMITH_SERVER_PORT: String(addr.port) });
  if (result.code !== 0) return 1;
  if ((await d.probeHealth(addr.baseUrl)).reachable) {
    d.err(`Something still answers at ${addr.baseUrl}. Check it with: lsof -nP -iTCP:${addr.port} -sTCP:LISTEN`);
    return 1;
  }
  if (!all || d.runtime() !== 'local') return 0;
  const pg = await d.stopPostgres();
  if (pg === 'survived') {
    d.err('Embedded Postgres did not exit.');
    return 1;
  }
  if (pg === 'foreign') {
    d.err('The Postgres on MEMSMITH_LOCAL_PG_PORT belongs to another data directory; left it running.');
    return 1;
  }
  d.out(pg === 'stopped' ? 'Embedded Postgres stopped' : 'Embedded Postgres was not running');
  return 0;
}

async function status(d: LifecycleDeps, addr: ReturnType<typeof resolveServerAddress>): Promise<number> {
  const health = await d.probeHealth(addr.baseUrl);
  const runtime = d.runtime();
  const pgLine = runtime === 'local' ? `  Postgres:  ${d.postgresRunning() ? 'running' : 'stopped'}` : null;
  if (!health.reachable) {
    d.out('Server is not running');
    if (pgLine) d.out(pgLine);
    return 1;
  }
  d.out(health.initialized ? 'Server is running' : 'Server is starting');
  d.out(`  PID:       ${health.pid ?? 'unknown'}`);
  d.out(`  Address:   ${addr.baseUrl}`);
  d.out(`  Runtime:   ${runtime} (as selected for the plugin directory)`);
  d.out(`  Version:   ${health.version ?? 'unknown'} (plugin ${d.pluginVersion()})`);
  d.out(`  Dashboard: ${addr.baseUrl}`);
  if (pgLine) d.out(pgLine);
  return 0;
}

const USAGE: Record<LifecycleCommand, string> = {
  start: 'memsmith start [--timeout <s>]',
  stop: 'memsmith stop [--all]',
  restart: 'memsmith restart [--timeout <s>]',
  status: 'memsmith status',
};

const KNOWN_FLAGS: Record<LifecycleCommand, string[]> = {
  start: ['--timeout'],
  stop: ['--all'],
  restart: ['--timeout'],
  status: [],
};

function checkArgs(command: LifecycleCommand, argv: string[], d: LifecycleDeps): number | null {
  if (argv.includes('--help') || argv.includes('-h')) {
    d.out(`Usage: ${USAGE[command]}`);
    return 0;
  }
  const valueFlag = KNOWN_FLAGS[command].includes('--timeout');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0];
    if (!KNOWN_FLAGS[command].includes(name)) {
      d.err(`Unknown option: ${arg}`);
      d.err(`Usage: ${USAGE[command]}`);
      return 1;
    }
    if (valueFlag && !arg.includes('=')) i++;
  }
  return null;
}

export async function runLifecycle(
  command: LifecycleCommand,
  argv: string[],
  d: LifecycleDeps = defaultLifecycleDeps(),
): Promise<number> {
  const argError = checkArgs(command, argv, d);
  if (argError !== null) return argError;
  const addr = resolveServerAddress(d.serverUrl());
  if (addr.remote) {
    d.err(`MEMSMITH_SERVER_URL points at a remote server (${addr.baseUrl}). Lifecycle commands manage only a local server.`);
    return 1;
  }
  switch (command) {
    case 'start': return start(argv, d, addr);
    case 'stop': return stop(argv, d, addr);
    case 'status': return status(d, addr);
    case 'restart': {
      const stopped = await stop([], d, addr);
      return stopped === 0 ? start(argv, d, addr) : stopped;
    }
  }
}

function serverScriptPath(): string {
  const scriptsDir = join(marketplaceDirectory(), 'plugin', 'scripts');
  const renamed = join(scriptsDir, 'server-service.cjs');
  return existsSync(renamed) ? renamed : join(scriptsDir, 'server-beta-service.cjs');
}

export function defaultLifecycleDeps(): LifecycleDeps {
  const fail = (message: string): never => {
    console.error(styleText('red', message));
    process.exit(1);
  };
  return {
    runScript: (args, env) => new Promise((resolve) => {
      if (!isPluginInstalled()) fail('memsmith is not installed. Run: npx memsmith install');
      const bun = getBunPath() ?? fail('Bun not found. Install Bun: https://bun.sh');
      const script = serverScriptPath();
      if (!existsSync(script)) fail(`Server script not found at: ${script}. Try: npx memsmith repair`);
      const child = spawnHidden(bun, [script, ...args], {
        cwd: marketplaceDirectory(),
        env: { ...sanitizeEnv(process.env), ...env },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.on('error', (error) => fail(`Failed to start Bun: ${error.message}`));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    }),
    probeHealth: async (baseUrl) => {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          reachable: true,
          httpStatus: res.status,
          initialized: body.initialized === true,
          version: typeof body.version === 'string' ? body.version : undefined,
          pid: typeof body.pid === 'number' ? body.pid : undefined,
          status: typeof body.status === 'string' ? body.status : undefined,
        };
      } catch {
        return { reachable: false };
      }
    },
    isAlive: isPidAlive,
    stopProcess: async (pid, termWaitMs) => (await import('../../server/runtime/stop-process.js')).stopProcess(pid, { termWaitMs }),
    stopPostgres: () => new EmbeddedPostgresManager().stopExternal(),
    postgresRunning: () => new EmbeddedPostgresManager().isRunning(),
    runtime: () => selectRuntime(marketplaceDirectory()),
    pluginVersion: () => installedPluginVersion(),
    serverUrl: () => SettingsDefaultsManager.get('MEMSMITH_SERVER_URL'),
    logPath: () => join(paths.logsDir(), `memsmith-${new Date().toISOString().slice(0, 10)}.log`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(styleText('yellow', line)),
  };
}
