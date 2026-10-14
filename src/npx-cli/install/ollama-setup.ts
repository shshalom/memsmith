// SPDX-License-Identifier: Apache-2.0
//
// Gets Ollama to the point where it can generate memories: installed, running,
// and holding the configured model. Every external command goes through a
// CommandRunner so tests never install or download anything.

import { spawn, spawnSync } from 'child_process';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { probeOllama, type OllamaTarget } from '../../cli/handlers/generation-readiness.js';

export type OllamaState = 'not-installed' | 'not-running' | 'model-missing' | 'ready' | 'unknown';

/** `opt-in` is `--setup-ollama`: perform every step without asking. */
export type OllamaSetupMode = 'interactive' | 'non-interactive' | 'opt-in';

export interface OllamaHost {
  platform: NodeJS.Platform;
  hasBrew: boolean;
  installedViaBrew: boolean;
  hasTty: boolean;
  isRoot: boolean;
  /** False when the configured Ollama runs on another machine. */
  localTarget: boolean;
}

export type OllamaAction =
  | { kind: 'brew-install' }
  | { kind: 'linux-install' }
  | { kind: 'brew-start' }
  | { kind: 'serve' }
  | { kind: 'pull'; model: string };

export type OllamaDecision =
  | { kind: 'ready'; message: string }
  | { kind: 'warn'; message: string; commands: string[] }
  | { kind: 'ask'; message: string; question: string; action: OllamaAction; declineCommands: string[] }
  | { kind: 'run'; action: OllamaAction };

export const LINUX_INSTALL_COMMAND = 'curl -fsSL https://ollama.com/install.sh | sh';
const DOWNLOAD_URL = 'https://ollama.com/download';

function downloadSize(model: string): string {
  return model === 'qwen2.5:14b' ? '~9 GB' : 'multi-GB';
}

function installCommands(host: OllamaHost): string[] {
  if (host.platform === 'darwin') {
    return host.hasBrew ? ['brew install ollama', 'brew services start ollama'] : [`Download Ollama from ${DOWNLOAD_URL}`];
  }
  if (host.platform === 'linux') return [LINUX_INSTALL_COMMAND];
  if (host.platform === 'win32') return ['winget install Ollama.Ollama', `or download it from ${DOWNLOAD_URL}`];
  return [`Download Ollama from ${DOWNLOAD_URL}`];
}

const DEFAULT_OLLAMA_PORT = '11434';

/** `host:port` for OLLAMA_HOST, so `ollama serve` and `ollama pull` use the configured address. */
export function ollamaHostFor(origin: string): string {
  const url = new URL(origin);
  return url.port ? url.host : `${url.hostname}:${DEFAULT_OLLAMA_PORT}`;
}

function usesDefaultPort(origin: string): boolean {
  return ollamaHostFor(origin).endsWith(`:${DEFAULT_OLLAMA_PORT}`);
}

// The Homebrew service always listens on the default port.
export function startAction(host: OllamaHost, origin: string): OllamaAction {
  return host.platform === 'darwin' && host.installedViaBrew && usesDefaultPort(origin) ? { kind: 'brew-start' } : { kind: 'serve' };
}

const OLLAMA_MODEL_NAME = /^[\w.:\/-]+$/;

export function isValidOllamaModel(model: string): boolean {
  return OLLAMA_MODEL_NAME.test(model);
}

export function actionCommand(action: OllamaAction, origin?: string): string {
  const prefix = origin && !usesDefaultPort(origin) ? `OLLAMA_HOST=${ollamaHostFor(origin)} ` : '';
  switch (action.kind) {
    case 'brew-install': return 'brew install ollama && brew services start ollama';
    case 'linux-install': return LINUX_INSTALL_COMMAND;
    case 'brew-start': return 'brew services start ollama';
    case 'serve': return `${prefix}ollama serve`;
    case 'pull': return `${prefix}ollama pull ${action.model}`;
  }
}

export function decideOllamaStep(ctx: {
  state: OllamaState;
  mode: OllamaSetupMode;
  host: OllamaHost;
  model: string;
  origin: string;
}): OllamaDecision {
  const { state, mode, host, model, origin } = ctx;
  const pull = actionCommand({ kind: 'pull', model }, origin);

  if (state === 'ready') return { kind: 'ready', message: `Ollama is ready: ${model} at ${origin}.` };
  if (state === 'unknown') {
    return { kind: 'warn', message: `Something answered at ${origin}, but not like Ollama. Check MEMSMITH_OLLAMA_URL.`, commands: [] };
  }
  if (!isValidOllamaModel(model)) {
    return { kind: 'warn', message: `"${model}" is not a valid Ollama model name. Fix MEMSMITH_SERVER_MODEL in ~/.memsmith/settings.json.`, commands: [] };
  }

  if (!host.localTarget) {
    const message = state === 'model-missing'
      ? `The Ollama at ${origin} does not have ${model}. Pull it on that machine.`
      : `MemSmith cannot reach the Ollama at ${origin}. Start Ollama on that machine.`;
    return { kind: 'warn', message, commands: [pull] };
  }

  const offer = (message: string, question: string, action: OllamaAction, declineCommands: string[]): OllamaDecision => {
    if (mode === 'interactive') return { kind: 'ask', message, question, action, declineCommands };
    if (mode === 'opt-in') return { kind: 'run', action };
    return { kind: 'warn', message, commands: declineCommands };
  };

  if (state === 'not-installed') {
    const message = 'Ollama is not installed. MemSmith uses it to turn your sessions into memories.';
    const commands = [...installCommands(host), pull];
    if (host.platform === 'darwin' && host.hasBrew) {
      return offer(message, `Install Ollama now? (Homebrew, then a ${downloadSize(model)} model download)`, { kind: 'brew-install' }, commands);
    }
    // The official script may prompt for sudo, which needs a terminal.
    if (host.platform === 'linux' && (mode === 'interactive' || host.hasTty || host.isRoot)) {
      return offer(message, `Install Ollama now with the official script from ollama.com? (may ask for your password, then a ${downloadSize(model)} model download)`, { kind: 'linux-install' }, commands);
    }
    return { kind: 'warn', message, commands };
  }

  if (state === 'not-running') {
    const action = startAction(host, origin);
    return offer(`Ollama is installed but not running at ${origin}.`, 'Start Ollama now?', action, [actionCommand(action, origin), pull]);
  }

  return offer(
    `Ollama is running, but the model ${model} is not downloaded.`,
    `Download ${model} now? (${downloadSize(model)})`,
    { kind: 'pull', model },
    [pull],
  );
}

export interface CommandRunner {
  /** Runs attached to the terminal; resolves to the exit code. */
  run(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<number>;
  spawnDetached(cmd: string, args: string[], extraEnv?: Record<string, string>): boolean;
  succeeds(cmd: string, args: string[]): boolean;
}

export async function executeOllamaAction(action: OllamaAction, runner: CommandRunner, ollamaHost?: string): Promise<boolean> {
  const hostEnv = ollamaHost ? { OLLAMA_HOST: ollamaHost } : undefined;
  switch (action.kind) {
    case 'brew-install':
      return (await runner.run('brew', ['install', 'ollama'])) === 0
        && (await runner.run('brew', ['services', 'start', 'ollama'])) === 0;
    case 'linux-install':
      return (await runner.run('sh', ['-c', LINUX_INSTALL_COMMAND])) === 0;
    case 'brew-start':
      return (await runner.run('brew', ['services', 'start', 'ollama'])) === 0;
    case 'serve':
      return runner.spawnDetached('ollama', ['serve'], hostEnv);
    case 'pull':
      if (!isValidOllamaModel(action.model)) return false;
      return (await runner.run('ollama', ['pull', action.model], hostEnv)) === 0;
  }
}

export interface OllamaSetupDeps {
  mode: OllamaSetupMode;
  host: OllamaHost;
  model: string;
  origin: string;
  probe(): Promise<OllamaState>;
  confirm(question: string): Promise<boolean>;
  run(action: OllamaAction): Promise<boolean>;
  waitUntilUp(): Promise<boolean>;
  out(line: string): void;
  warn(line: string): void;
}

function warnWithCommands(deps: OllamaSetupDeps, message: string, commands: string[]): void {
  deps.warn(commands.length > 0 ? `${message}\nTo fix it, run:\n${commands.map((c) => `  ${c}`).join('\n')}` : message);
}

export async function runOllamaSetup(deps: OllamaSetupDeps): Promise<{ ready: boolean }> {
  const attempted = new Set<OllamaAction['kind']>();
  for (let step = 0; step < 5; step++) {
    const state = await deps.probe();
    const decision = decideOllamaStep({ state, mode: deps.mode, host: deps.host, model: deps.model, origin: deps.origin });
    if (decision.kind === 'ready') {
      deps.out(decision.message);
      return { ready: true };
    }
    if (decision.kind === 'warn') {
      warnWithCommands(deps, decision.message, decision.commands);
      return { ready: false };
    }
    const { action } = decision;
    if (attempted.has(action.kind)) {
      warnWithCommands(deps, `Ollama is still not ready after \`${actionCommand(action, deps.origin)}\`.`, [actionCommand(action, deps.origin), actionCommand({ kind: 'pull', model: deps.model }, deps.origin)]);
      return { ready: false };
    }
    if (decision.kind === 'ask') {
      deps.out(decision.message);
      if (!(await deps.confirm(decision.question))) {
        warnWithCommands(deps, 'Skipped. MemSmith cannot create memories until Ollama is ready.', decision.declineCommands);
        return { ready: false };
      }
    }
    attempted.add(action.kind);
    if (!(await deps.run(action))) {
      warnWithCommands(deps, `\`${actionCommand(action, deps.origin)}\` failed.`, [actionCommand(action, deps.origin)]);
      return { ready: false };
    }
    if (action.kind !== 'pull') await deps.waitUntilUp();
  }
  return { ready: false };
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

// sanitizeEnv strips proxy settings for the SDK subprocess, but brew, the
// install script, and `ollama pull` need them behind a corporate proxy.
export function pickProxyVars(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of PROXY_VARS) {
    for (const key of [name, name.toLowerCase()]) {
      const value = env[key];
      if (value !== undefined) picked[key] = value;
    }
  }
  return picked;
}

// No shell anywhere: the model name reaches `ollama pull` as an argument, never
// as shell text. The Linux installer pipes through `sh -c` with a fixed string.
export function defaultCommandRunner(baseEnv: NodeJS.ProcessEnv = process.env): CommandRunner {
  return {
    run: (cmd, args, extraEnv) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'inherit', env: { ...sanitizeEnv(baseEnv), ...pickProxyVars(baseEnv), ...extraEnv } });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    }),
    spawnDetached: (cmd, args, extraEnv) => {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...sanitizeEnv(baseEnv), ...pickProxyVars(baseEnv), ...extraEnv } });
        child.on('error', () => {});
        child.unref();
        return child.pid !== undefined;
      } catch {
        return false;
      }
    },
    succeeds: (cmd, args) => {
      try {
        return spawnSync(cmd, args, { stdio: 'ignore', env: { ...sanitizeEnv(baseEnv), ...pickProxyVars(baseEnv) }, timeout: 10_000 }).status === 0;
      } catch {
        return false;
      }
    },
  };
}

export function detectOllamaHost(runner: CommandRunner, target: OllamaTarget, hasTty: boolean): OllamaHost {
  const platform = process.platform;
  const hasBrew = platform === 'darwin' && runner.succeeds('brew', ['--version']);
  return {
    platform,
    hasBrew,
    installedViaBrew: hasBrew && runner.succeeds('brew', ['list', '--formula', 'ollama']),
    hasTty,
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    localTarget: target.local,
  };
}

export async function probeOllamaState(target: OllamaTarget, runner: CommandRunner): Promise<OllamaState> {
  const result = await probeOllama(target);
  if (result !== 'unreachable') return result;
  return runner.succeeds('ollama', ['--version']) ? 'not-running' : 'not-installed';
}

export async function waitForOllama(target: OllamaTarget, timeoutMs = 20_000, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeOllama(target, { timeoutMs: 1000 })) !== 'unreachable') return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
