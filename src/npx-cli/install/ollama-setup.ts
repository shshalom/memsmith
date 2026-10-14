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

export function startAction(host: OllamaHost): OllamaAction {
  return host.platform === 'darwin' && host.installedViaBrew ? { kind: 'brew-start' } : { kind: 'serve' };
}

export function actionCommand(action: OllamaAction): string {
  switch (action.kind) {
    case 'brew-install': return 'brew install ollama && brew services start ollama';
    case 'linux-install': return LINUX_INSTALL_COMMAND;
    case 'brew-start': return 'brew services start ollama';
    case 'serve': return 'ollama serve';
    case 'pull': return `ollama pull ${action.model}`;
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
  const pull = `ollama pull ${model}`;

  if (state === 'ready') return { kind: 'ready', message: `Ollama is ready: ${model} at ${origin}.` };
  if (state === 'unknown') {
    return { kind: 'warn', message: `Something answered at ${origin}, but not like Ollama. Check MEMSMITH_OLLAMA_URL.`, commands: [] };
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
    const action = startAction(host);
    return offer(`Ollama is installed but not running at ${origin}.`, 'Start Ollama now?', action, [actionCommand(action), pull]);
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
  run(cmd: string, args: string[]): Promise<number>;
  spawnDetached(cmd: string, args: string[]): boolean;
  succeeds(cmd: string, args: string[]): boolean;
}

export async function executeOllamaAction(action: OllamaAction, runner: CommandRunner): Promise<boolean> {
  switch (action.kind) {
    case 'brew-install':
      return (await runner.run('brew', ['install', 'ollama'])) === 0
        && (await runner.run('brew', ['services', 'start', 'ollama'])) === 0;
    case 'linux-install':
      return (await runner.run('sh', ['-c', LINUX_INSTALL_COMMAND])) === 0;
    case 'brew-start':
      return (await runner.run('brew', ['services', 'start', 'ollama'])) === 0;
    case 'serve':
      return runner.spawnDetached('ollama', ['serve']);
    case 'pull':
      return (await runner.run('ollama', ['pull', action.model])) === 0;
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
      warnWithCommands(deps, `Ollama is still not ready after \`${actionCommand(action)}\`.`, [actionCommand(action), `ollama pull ${deps.model}`]);
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
      warnWithCommands(deps, `\`${actionCommand(action)}\` failed.`, [actionCommand(action)]);
      return { ready: false };
    }
    if (action.kind !== 'pull') await deps.waitUntilUp();
  }
  return { ready: false };
}

export function defaultCommandRunner(): CommandRunner {
  const shell = process.platform === 'win32';
  return {
    run: (cmd, args) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'inherit', shell, env: sanitizeEnv(process.env) });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    }),
    spawnDetached: (cmd, args) => {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell, env: sanitizeEnv(process.env) });
        child.on('error', () => {});
        child.unref();
        return child.pid !== undefined;
      } catch {
        return false;
      }
    },
    succeeds: (cmd, args) => {
      try {
        return spawnSync(cmd, args, { stdio: 'ignore', shell, env: sanitizeEnv(process.env), timeout: 10_000 }).status === 0;
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
