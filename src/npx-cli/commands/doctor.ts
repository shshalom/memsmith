/**
 * `memsmith doctor` — a diagnostic that probes every layer an operator would
 * otherwise check by hand (#2548). Read-only unless `--fix` is passed. Exits 0
 * when all REQUIRED checks pass, 1 otherwise, so it is CI/script friendly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { styleText } from 'node:util';
import { isPluginInstalled, marketplaceDirectory, IS_WINDOWS } from '../utils/paths.js';
import { resolveDataDir } from '../../shared/paths.js';
import { connect } from 'node:net';
import { readServerPidFile, removeServerState } from '../../server/runtime/server-state.js';
import { verifyPidFileOwnership } from '../../supervisor/process-registry.js';
import { installedPluginVersion } from '../utils/paths.js';
import { resolveServerAddress } from './lifecycle.js';
import { resolveServerUrl, ServerUrlError, type ServerUrlSource } from '../utils/server-url.js';
import { resolveOllamaTarget } from '../../cli/handlers/generation-readiness.js';
import { loadGenerationConfigSources, missingGenerationCredential } from '../../server/runtime/generation-credentials.js';
import { resolveGenerationProviderName, GENERATION_PROVIDERS } from '../../server/runtime/resolve-generation-provider.js';
import {
  defaultCommandRunner,
  detectOllamaHost,
  executeOllamaAction,
  probeOllamaState,
  startAction,
  waitForOllama,
  type OllamaState,
} from '../install/ollama-setup.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a 'fail' does not affect the overall exit code. */
  required: boolean;
}

function probeVersion(bin: string): string | null {
  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn(`[doctor] Failed to probe \`${bin} --version\`:`, err);
    return null;
  }
}

export type Repair = 'remove-stale-state' | 'install-deps' | 'restart' | 'start' | 'start-ollama' | 'pull-ollama-model';

export type GenerationStatus =
  | { provider: null; configured: string }
  | { provider: 'ollama'; ollama: OllamaState; model: string; origin: string; local?: boolean }
  | { provider: 'claude' | 'gemini' | 'openrouter'; missingCredential: string | null };

export interface DoctorState {
  pidFileStale: boolean;
  portInUse: boolean;
  depsMissing: boolean;
  serverReachable: boolean;
  serverVersion?: string;
  pluginVersion: string;
  remote: boolean;
  generation?: GenerationStatus;
}

export interface RepairDeps {
  removeState(): void;
  installDeps(): Promise<void>;
  lifecycle(cmd: 'start' | 'restart'): Promise<number>;
  ollama(action: 'start' | 'pull'): Promise<boolean>;
  out(line: string): void;
}

export type DoctorArgs =
  | { kind: 'run'; fix: boolean }
  | { kind: 'help' }
  | { kind: 'unknown'; flag: string };

export const DOCTOR_USAGE = 'Usage: memsmith doctor [--fix]';

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const unknown = argv.find((arg) => arg !== '--fix');
  if (unknown !== undefined) return { kind: 'unknown', flag: unknown };
  return { kind: 'run', fix: argv.includes('--fix') };
}

export function versionMismatchStatus(ctx: { restarted: boolean }): CheckStatus {
  return ctx.restarted ? 'fail' : 'warn';
}

export function generationCheck(status: GenerationStatus, remote: boolean): CheckResult {
  const result = (s: CheckStatus, detail: string): CheckResult => ({ name: 'Generation', status: s, detail, required: true });
  if (remote) return { ...result('warn', 'runs on the team server; not checked locally'), required: false };
  if (status.provider === null) {
    return result('fail', `MEMSMITH_SERVER_PROVIDER "${status.configured}" is not one of ${GENERATION_PROVIDERS.join(', ')}`);
  }
  if (status.provider !== 'ollama') {
    return status.missingCredential
      ? result('fail', `${status.provider} · no API key — set ${status.missingCredential}`)
      : result('ok', `${status.provider} · API key present`);
  }
  const { model, origin } = status;
  switch (status.ollama) {
    case 'ready': return result('ok', `ollama · ${model} at ${origin}`);
    case 'model-missing': return result('fail', `ollama · model ${model} missing — run \`ollama pull ${model}\` or \`memsmith doctor --fix\``);
    case 'not-running': return result('fail', status.local === false
      ? `ollama · not reachable at ${origin} — start Ollama on that machine`
      : `ollama · not running at ${origin} — run \`memsmith doctor --fix\` to start it`);
    case 'not-installed': return result('fail', `ollama · not installed — download it from https://ollama.com/download, then run \`ollama pull ${model}\``);
    case 'unknown': return { ...result('warn', `ollama · ${origin} answered, but not like Ollama — check MEMSMITH_OLLAMA_URL`), required: false };
  }
}

export function planRepairs(s: DoctorState): Repair[] {
  const repairs: Repair[] = [];
  if (!s.remote && s.pidFileStale && !s.portInUse) repairs.push('remove-stale-state');
  if (s.depsMissing) repairs.push('install-deps');
  if (s.remote) return repairs;
  const gen = s.generation;
  if (gen?.provider === 'ollama' && gen.local !== false) {
    // `ollama pull` on a model that is already present only verifies it.
    if (gen.ollama === 'not-running') repairs.push('start-ollama', 'pull-ollama-model');
    else if (gen.ollama === 'model-missing') repairs.push('pull-ollama-model');
  }
  if (!s.serverReachable) repairs.push('start');
  else if (s.serverVersion && s.serverVersion !== s.pluginVersion) repairs.push('restart');
  return repairs;
}

export async function applyRepairs(
  repairs: Repair[],
  deps: RepairDeps,
): Promise<{ ok: true } | { ok: false; failed: Repair; error: string }> {
  for (const repair of repairs) {
    deps.out(`Fixing: ${repair}`);
    try {
      if (repair === 'remove-stale-state') deps.removeState();
      else if (repair === 'install-deps') await deps.installDeps();
      else if (repair === 'start-ollama' || repair === 'pull-ollama-model') {
        if (!(await deps.ollama(repair === 'start-ollama' ? 'start' : 'pull'))) {
          return { ok: false, failed: repair, error: repair === 'start-ollama' ? 'Ollama did not start' : 'ollama pull failed' };
        }
      }
      else if ((await deps.lifecycle(repair)) !== 0) {
        return { ok: false, failed: repair, error: `memsmith ${repair} failed` };
      }
    } catch (error) {
      return { ok: false, failed: repair, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true };
}

async function probeServerHealth(baseUrl: string): Promise<{ reachable: boolean; version?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json().catch(() => ({}))) as { version?: unknown };
    return { reachable: true, version: typeof body.version === 'string' ? body.version : undefined };
  } catch {
    return { reachable: false };
  }
}

function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

export interface DoctorProbes {
  probeVersion(bin: string): string | null;
  isPluginInstalled(): boolean;
  marketplaceDirectory(): string;
  installedPluginVersion(): string;
  probeServerHealth(baseUrl: string): Promise<{ reachable: boolean; version?: string }>;
  readServerPidFile(): ReturnType<typeof readServerPidFile>;
  verifyPidFileOwnership(info: NonNullable<ReturnType<typeof readServerPidFile>>): boolean;
  isPortInUse(host: string, port: number): Promise<boolean>;
  dataDir(): string;
  generation(): Promise<GenerationStatus>;
}

async function probeGeneration(): Promise<GenerationStatus> {
  const sources = loadGenerationConfigSources();
  const provider = resolveGenerationProviderName(sources.env, sources.settings);
  if (provider === null) {
    return { provider: null, configured: String(sources.env.MEMSMITH_SERVER_PROVIDER || sources.settings.MEMSMITH_SERVER_PROVIDER) };
  }
  if (provider !== 'ollama') return { provider, missingCredential: missingGenerationCredential(provider, sources) };
  const target = resolveOllamaTarget(sources.settings, sources.env);
  if (!target) return { provider: 'ollama', ollama: 'unknown', model: '', origin: 'MEMSMITH_OLLAMA_URL' };
  const ollama = await probeOllamaState(target, defaultCommandRunner());
  return { provider: 'ollama', ollama, model: target.model, origin: target.origin, local: target.local };
}

async function repairOllama(action: 'start' | 'pull'): Promise<boolean> {
  const sources = loadGenerationConfigSources();
  const target = resolveOllamaTarget(sources.settings, sources.env);
  if (!target) return false;
  const runner = defaultCommandRunner();
  if (action === 'pull') return executeOllamaAction({ kind: 'pull', model: target.model }, runner);
  const host = detectOllamaHost(runner, target, process.stdin.isTTY === true);
  return (await executeOllamaAction(startAction(host), runner)) && waitForOllama(target);
}

const defaultProbes: DoctorProbes = {
  probeVersion,
  isPluginInstalled,
  marketplaceDirectory: () => marketplaceDirectory(),
  installedPluginVersion: () => installedPluginVersion(),
  probeServerHealth,
  readServerPidFile: () => readServerPidFile(),
  verifyPidFileOwnership,
  isPortInUse,
  dataDir: resolveDataDir,
  generation: probeGeneration,
};

export async function collectChecks(
  fix: boolean,
  restarted: boolean,
  urlSource: ServerUrlSource = {},
  probes: DoctorProbes = defaultProbes,
): Promise<{ checks: CheckResult[]; state: DoctorState }> {
  const address = resolveServerAddress(resolveServerUrl(urlSource));
  const checks: CheckResult[] = [];
  const dataDir = probes.dataDir();

  // 1. Bun (required — hooks run on Bun).
  const bunVersion = probes.probeVersion('bun');
  checks.push({
    name: 'Bun runtime',
    status: bunVersion ? 'ok' : 'fail',
    detail: bunVersion ? `v${bunVersion.replace(/^v/, '')}` : 'not found on PATH — install: https://bun.sh',
    required: true,
  });

  // 2. uv (warn-only — only needed for vector search).
  const uvVersion = probes.probeVersion('uv');
  checks.push({
    name: 'uv (vector search)',
    status: uvVersion ? 'ok' : 'warn',
    detail: uvVersion ? uvVersion : 'not found — vector/semantic search disabled until installed',
    required: false,
  });

  // 3. Plugin installed in the marketplace.
  const installed = probes.isPluginInstalled();
  checks.push({
    name: 'Plugin installed',
    status: installed ? 'ok' : 'fail',
    detail: installed ? probes.marketplaceDirectory() : 'run `npx memsmith install`',
    required: true,
  });

  // 4. Marketplace dependencies materialized.
  const marketplaceNodeModules = join(probes.marketplaceDirectory(), 'node_modules');
  const depsPresent = existsSync(marketplaceNodeModules);
  checks.push({
    name: 'Marketplace deps',
    status: installed ? (depsPresent ? 'ok' : 'fail') : 'warn',
    detail: depsPresent ? 'node_modules present' : 'missing — run `npx memsmith repair`',
    required: installed,
  });

  // 5. Server health.
  const pluginVersion = probes.installedPluginVersion();
  const health = await probes.probeServerHealth(address.baseUrl);
  let serverStatus: CheckStatus;
  let serverDetail: string;
  if (address.remote) {
    serverStatus = 'warn';
    serverDetail = `remote server at ${address.baseUrl}; not managed by doctor`;
  } else if (!health.reachable) {
    serverStatus = 'fail';
    serverDetail = 'not running — run `memsmith start` or `memsmith doctor --fix`';
  } else if (health.version && health.version !== pluginVersion) {
    serverStatus = versionMismatchStatus({ restarted });
    serverDetail = `running ${health.version}, plugin is ${pluginVersion} — run \`memsmith restart\``;
  } else {
    serverStatus = 'ok';
    serverDetail = `healthy at ${address.baseUrl}${health.version ? ` (${health.version})` : ''}`;
  }
  checks.push({ name: 'Server', status: serverStatus, detail: serverDetail, required: fix });

  const generation = await probes.generation();
  checks.push(generationCheck(generation, address.remote));

  // 6. Last recorded install error (surface remediation if present).
  const lastErrorPath = join(dataDir, 'last-install-error.json');
  if (existsSync(lastErrorPath)) {
    let detail = `present at ${lastErrorPath}`;
    try {
      const record = JSON.parse(readFileSync(lastErrorPath, 'utf-8'));
      if (record && typeof record === 'object') {
        detail = `${record.categoryId ?? 'error'}: ${record.remediation ?? detail}`;
      }
    } catch {
      // keep generic detail
    }
    checks.push({
      name: 'Last install error',
      status: 'warn',
      detail,
      required: false,
    });
  }

  const pidInfo = probes.readServerPidFile();
  const state: DoctorState = {
    pidFileStale: pidInfo !== null && !probes.verifyPidFileOwnership(pidInfo),
    portInUse: address.remote ? false : await probes.isPortInUse(address.host, address.port),
    depsMissing: installed && !depsPresent,
    serverReachable: health.reachable,
    serverVersion: health.version,
    pluginVersion,
    remote: address.remote,
    generation,
  };
  return { checks, state };
}

function printChecks(checks: CheckResult[]): void {
  const icon = (s: CheckStatus): string =>
    s === 'ok' ? styleText('green', '✓') : s === 'warn' ? styleText('yellow', '!') : styleText('red', '✗');

  console.log(styleText('bold', '\nmemsmith doctor\n'));
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.name.padEnd(22)} ${styleText('dim', c.detail)}`);
  }
}

function reportExitCode(checks: CheckResult[]): number {
  const hardFailures = checks.filter((c) => c.required && c.status === 'fail');
  console.log('');
  if (hardFailures.length === 0) {
    console.log(styleText('green', 'All required checks passed.'));
    return 0;
  }
  console.log(styleText('red', `${hardFailures.length} required check(s) failed — see remediation above.`));
  return 1;
}

async function collectChecksOrExit(
  fix: boolean,
  restarted: boolean,
  urlSource: ServerUrlSource,
): Promise<{ checks: CheckResult[]; state: DoctorState }> {
  try {
    return await collectChecks(fix, restarted, urlSource);
  } catch (error) {
    if (!(error instanceof ServerUrlError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

export async function runDoctorCommand(argv: string[] = [], urlSource: ServerUrlSource = {}): Promise<void> {
  const args = parseDoctorArgs(argv);
  if (args.kind === 'help') {
    console.log(DOCTOR_USAGE);
    process.exit(0);
  }
  if (args.kind === 'unknown') {
    console.error(`Unknown option: ${args.flag}\n${DOCTOR_USAGE}`);
    process.exit(1);
  }

  const { checks, state } = await collectChecksOrExit(args.fix, false, urlSource);
  printChecks(checks);
  if (!args.fix) process.exit(reportExitCode(checks));

  const repairs = planRepairs(state);
  const result = await applyRepairs(repairs, {
    removeState: () => removeServerState(),
    installDeps: async () => (await import('./install.js')).installMarketplaceDependencies(),
    lifecycle: async (cmd) => {
      const { runLifecycle, defaultLifecycleDeps } = await import('./lifecycle.js');
      return runLifecycle(cmd, [], defaultLifecycleDeps(urlSource));
    },
    ollama: repairOllama,
    out: (line) => console.log(styleText('cyan', `  → ${line}`)),
  });
  if (!result.ok) {
    console.error(`Repair failed at ${result.failed}: ${result.error}`);
    process.exit(1);
  }

  const after = await collectChecksOrExit(true, repairs.includes('restart') || repairs.includes('start'), urlSource);
  printChecks(after.checks);
  process.exit(reportExitCode(after.checks));
}
