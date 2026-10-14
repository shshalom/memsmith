// SPDX-License-Identifier: Apache-2.0
//
// The installer never checked that Ollama was installed, running, or had the
// model. An install "succeeded" on a machine without Ollama and could never
// create a memory; the only sign was a SessionStart notice later.
import { describe, it, expect } from 'bun:test';
import {
  decideOllamaStep,
  defaultCommandRunner,
  executeOllamaAction,
  isValidOllamaModel,
  ollamaHostFor,
  runOllamaSetup,
  type CommandRunner,
  type OllamaHost,
  type OllamaSetupMode,
  type OllamaState,
} from '../../src/npx-cli/install/ollama-setup.js';

const MODEL = 'qwen2.5:14b';
const ORIGIN = 'http://localhost:11434';
const macBrew: OllamaHost = { platform: 'darwin', hasBrew: true, installedViaBrew: true, hasTty: true, isRoot: false, localTarget: true };
const macNoBrew: OllamaHost = { ...macBrew, hasBrew: false, installedViaBrew: false };
const linux: OllamaHost = { ...macNoBrew, platform: 'linux' };
const windows: OllamaHost = { ...macNoBrew, platform: 'win32' };

function decide(state: OllamaState, mode: OllamaSetupMode, host: OllamaHost = macBrew) {
  return decideOllamaStep({ state, mode, host, model: MODEL, origin: ORIGIN });
}

describe('decideOllamaStep', () => {
  it('confirms readiness in every mode', () => {
    for (const mode of ['interactive', 'non-interactive', 'opt-in'] as const) {
      expect(decide('ready', mode).kind).toBe('ready');
    }
  });

  describe('Ollama not installed', () => {
    it('asks before a Homebrew install on macOS', () => {
      const d = decide('not-installed', 'interactive');
      expect(d).toMatchObject({ kind: 'ask', action: { kind: 'brew-install' } });
      if (d.kind === 'ask') {
        expect(d.question).toContain('Homebrew');
        expect(d.question).toContain('9 GB');
        expect(d.declineCommands).toEqual(['brew install ollama', 'brew services start ollama', `ollama pull ${MODEL}`]);
      }
    });

    it('asks before running the official script on Linux', () => {
      const d = decide('not-installed', 'interactive', linux);
      expect(d).toMatchObject({ kind: 'ask', action: { kind: 'linux-install' } });
      if (d.kind === 'ask') expect(d.declineCommands[0]).toBe('curl -fsSL https://ollama.com/install.sh | sh');
    });

    it('never runs an installer on macOS without Homebrew', () => {
      for (const mode of ['interactive', 'opt-in'] as const) {
        const d = decide('not-installed', mode, macNoBrew);
        expect(d.kind).toBe('warn');
        if (d.kind === 'warn') expect(d.commands.join('\n')).toContain('https://ollama.com/download');
      }
    });

    it('never runs an installer on Windows', () => {
      for (const mode of ['interactive', 'opt-in'] as const) {
        const d = decide('not-installed', mode, windows);
        expect(d.kind).toBe('warn');
        if (d.kind === 'warn') expect(d.commands).toContain('winget install Ollama.Ollama');
      }
    });

    it('only warns in a non-interactive install', () => {
      expect(decide('not-installed', 'non-interactive').kind).toBe('warn');
      expect(decide('not-installed', 'non-interactive', linux).kind).toBe('warn');
    });

    it('installs without asking under --setup-ollama', () => {
      expect(decide('not-installed', 'opt-in')).toEqual({ kind: 'run', action: { kind: 'brew-install' } });
      expect(decide('not-installed', 'opt-in', linux)).toEqual({ kind: 'run', action: { kind: 'linux-install' } });
    });

    it('prints the Linux script instead of running it when sudo could not prompt', () => {
      const d = decide('not-installed', 'opt-in', { ...linux, hasTty: false });
      expect(d.kind).toBe('warn');
      if (d.kind === 'warn') expect(d.commands[0]).toBe('curl -fsSL https://ollama.com/install.sh | sh');
      expect(decide('not-installed', 'opt-in', { ...linux, hasTty: false, isRoot: true }).kind).toBe('run');
    });
  });

  describe('Ollama installed but not running', () => {
    it('offers to start the Homebrew service when Homebrew installed it', () => {
      expect(decide('not-running', 'interactive')).toMatchObject({ kind: 'ask', action: { kind: 'brew-start' } });
    });

    it('offers ollama serve otherwise', () => {
      expect(decide('not-running', 'interactive', linux)).toMatchObject({ kind: 'ask', action: { kind: 'serve' } });
      expect(decide('not-running', 'interactive', macNoBrew)).toMatchObject({ kind: 'ask', action: { kind: 'serve' } });
    });

    it('warns with the start and pull commands when non-interactive', () => {
      const d = decide('not-running', 'non-interactive', linux);
      expect(d).toEqual({
        kind: 'warn',
        message: expect.stringContaining(ORIGIN),
        commands: ['ollama serve', `ollama pull ${MODEL}`],
      });
    });

    it('starts it without asking under --setup-ollama', () => {
      expect(decide('not-running', 'opt-in')).toEqual({ kind: 'run', action: { kind: 'brew-start' } });
    });
  });

  describe('model missing', () => {
    it('asks before pulling the model', () => {
      const d = decide('model-missing', 'interactive');
      expect(d).toMatchObject({ kind: 'ask', action: { kind: 'pull', model: MODEL }, declineCommands: [`ollama pull ${MODEL}`] });
    });

    it('warns with the pull command when non-interactive', () => {
      expect(decide('model-missing', 'non-interactive')).toMatchObject({ kind: 'warn', commands: [`ollama pull ${MODEL}`] });
    });

    it('pulls without asking under --setup-ollama', () => {
      expect(decide('model-missing', 'opt-in')).toEqual({ kind: 'run', action: { kind: 'pull', model: MODEL } });
    });
  });

  it('never installs or starts anything for an Ollama on another machine', () => {
    const remote = { ...macBrew, localTarget: false };
    for (const state of ['not-installed', 'not-running', 'model-missing'] as const) {
      expect(decide(state, 'opt-in', remote).kind).toBe('warn');
      expect(decide(state, 'interactive', remote).kind).toBe('warn');
    }
  });
});

function recordingRunner(exitCode = 0) {
  const calls: string[] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const runner: CommandRunner = {
    run: async (cmd, args, extraEnv) => { calls.push([cmd, ...args].join(' ')); envs.push(extraEnv); return exitCode; },
    spawnDetached: (cmd, args, extraEnv) => { calls.push(`detached: ${[cmd, ...args].join(' ')}`); envs.push(extraEnv); return true; },
    succeeds: () => true,
  };
  return { calls, envs, runner };
}

describe('executeOllamaAction', () => {
  it('installs with Homebrew and starts the service', async () => {
    const { calls, runner } = recordingRunner();
    expect(await executeOllamaAction({ kind: 'brew-install' }, runner)).toBe(true);
    expect(calls).toEqual(['brew install ollama', 'brew services start ollama']);
  });

  it('runs the official Linux script through a shell', async () => {
    const { calls, runner } = recordingRunner();
    await executeOllamaAction({ kind: 'linux-install' }, runner);
    expect(calls).toEqual(['sh -c curl -fsSL https://ollama.com/install.sh | sh']);
  });

  it('starts ollama serve detached', async () => {
    const { calls, runner } = recordingRunner();
    await executeOllamaAction({ kind: 'serve' }, runner);
    expect(calls).toEqual(['detached: ollama serve']);
  });

  it('starts ollama serve rather than the Homebrew service for a custom port', () => {
    const d = decideOllamaStep({ state: 'not-running', mode: 'interactive', host: macBrew, model: MODEL, origin: 'http://127.0.0.1:11500' });
    expect(d).toMatchObject({ kind: 'ask', action: { kind: 'serve' } });
    if (d.kind === 'ask') expect(d.declineCommands).toEqual(['OLLAMA_HOST=127.0.0.1:11500 ollama serve', `OLLAMA_HOST=127.0.0.1:11500 ollama pull ${MODEL}`]);
  });

  it('points ollama serve and ollama pull at a custom loopback port', async () => {
    const host = ollamaHostFor('http://127.0.0.1:11500');
    expect(host).toBe('127.0.0.1:11500');
    const { envs, runner } = recordingRunner();
    await executeOllamaAction({ kind: 'serve' }, runner, host);
    await executeOllamaAction({ kind: 'pull', model: MODEL }, runner, host);
    expect(envs).toEqual([{ OLLAMA_HOST: '127.0.0.1:11500' }, { OLLAMA_HOST: '127.0.0.1:11500' }]);
  });

  it('refuses to pull a model name that is not a plain Ollama name', async () => {
    const { calls, runner } = recordingRunner();
    expect(await executeOllamaAction({ kind: 'pull', model: 'qwen; rm -rf ~' }, runner)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports a failed command', async () => {
    const { calls, runner } = recordingRunner(1);
    expect(await executeOllamaAction({ kind: 'brew-install' }, runner)).toBe(false);
    expect(calls).toEqual(['brew install ollama']);
  });
});

function setupHarness(states: OllamaState[], opts: { mode: OllamaSetupMode; consent?: boolean; host?: OllamaHost }) {
  const ran: string[] = [];
  const asked: string[] = [];
  const warnings: string[] = [];
  const out: string[] = [];
  let i = 0;
  const deps = {
    mode: opts.mode,
    host: opts.host ?? macBrew,
    model: MODEL,
    origin: ORIGIN,
    probe: async () => states[Math.min(i++, states.length - 1)],
    confirm: async (q: string) => { asked.push(q); return opts.consent ?? true; },
    run: async (action: { kind: string }) => { ran.push(action.kind); return true; },
    waitUntilUp: async () => true,
    out: (line: string) => out.push(line),
    warn: (line: string) => warnings.push(line),
  };
  return { deps, ran, asked, warnings, out };
}

describe('runOllamaSetup', () => {
  it('walks a bare machine to ready with consent at each step', async () => {
    const h = setupHarness(['not-installed', 'model-missing', 'ready'], { mode: 'interactive' });
    expect(await runOllamaSetup(h.deps)).toEqual({ ready: true });
    expect(h.ran).toEqual(['brew-install', 'pull']);
    expect(h.asked).toHaveLength(2);
    expect(h.out.join('\n')).toContain('ready');
  });

  it('runs nothing when the user declines, and prints the manual steps', async () => {
    const h = setupHarness(['not-installed'], { mode: 'interactive', consent: false });
    expect(await runOllamaSetup(h.deps)).toEqual({ ready: false });
    expect(h.ran).toEqual([]);
    expect(h.warnings.join('\n')).toContain('brew install ollama');
  });

  it('declining the model pull runs nothing and prints the pull command', async () => {
    const h = setupHarness(['model-missing'], { mode: 'interactive', consent: false });
    await runOllamaSetup(h.deps);
    expect(h.ran).toEqual([]);
    expect(h.warnings.join('\n')).toContain(`ollama pull ${MODEL}`);
  });

  it('never asks or runs anything in a non-interactive install', async () => {
    for (const state of ['not-installed', 'not-running', 'model-missing'] as const) {
      const h = setupHarness([state], { mode: 'non-interactive' });
      expect(await runOllamaSetup(h.deps)).toEqual({ ready: false });
      expect(h.ran).toEqual([]);
      expect(h.asked).toEqual([]);
      expect(h.warnings.length).toBeGreaterThan(0);
    }
  });

  it('performs every step without asking under --setup-ollama', async () => {
    const h = setupHarness(['not-installed', 'not-running', 'model-missing', 'ready'], { mode: 'opt-in', host: linux });
    expect(await runOllamaSetup(h.deps)).toEqual({ ready: true });
    expect(h.ran).toEqual(['linux-install', 'serve', 'pull']);
    expect(h.asked).toEqual([]);
  });

  it('stops instead of repeating an action that did not help', async () => {
    const h = setupHarness(['not-running', 'not-running', 'not-running'], { mode: 'opt-in' });
    expect(await runOllamaSetup(h.deps)).toEqual({ ready: false });
    expect(h.ran).toEqual(['brew-start']);
    expect(h.warnings.join('\n')).toContain('brew services start ollama');
  });
});

describe('isValidOllamaModel', () => {
  it('accepts names, tags, and namespaced models', () => {
    for (const m of ['qwen2.5:14b', 'llama3.1', 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M', 'library/mistral:7b-instruct']) {
      expect(isValidOllamaModel(m)).toBe(true);
    }
  });

  it('rejects anything a shell could interpret', () => {
    for (const m of ['', 'qwen; rm -rf ~', 'a b', '$(id)', 'x&y', 'm|n', '`id`']) {
      expect(isValidOllamaModel(m)).toBe(false);
    }
  });

  it('makes the setup warn instead of offering a pull', () => {
    const d = decideOllamaStep({ state: 'model-missing', mode: 'opt-in', host: macBrew, model: 'bad model', origin: ORIGIN });
    expect(d.kind).toBe('warn');
    if (d.kind === 'warn') expect(d.message).toContain('not a valid Ollama model name');
  });
});

// Behind a corporate proxy, `brew install`, the Linux script, and `ollama pull`
// all need the proxy variables that sanitizeEnv strips for the SDK subprocess.
// The runner takes the base environment as an argument: setting HTTP_PROXY on
// process.env here would make Bun's fetch use the proxy for later tests.
describe.skipIf(process.platform === 'win32')('defaultCommandRunner environment', () => {
  const base = { PATH: process.env.PATH, HTTP_PROXY: 'http://proxy:1', https_proxy: 'http://proxy:2', CLAUDE_CODE_EFFORT_LEVEL: 'high' };

  it('passes proxy variables through in both cases', () => {
    const runner = defaultCommandRunner(base);
    expect(runner.succeeds('sh', ['-c', '[ "$HTTP_PROXY" = "http://proxy:1" ] && [ "$https_proxy" = "http://proxy:2" ]'])).toBe(true);
  });

  it('still strips what sanitizeEnv strips', () => {
    expect(defaultCommandRunner(base).succeeds('sh', ['-c', '[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]'])).toBe(true);
  });

  it('hands OLLAMA_HOST to the command', async () => {
    const code = await defaultCommandRunner(base).run('sh', ['-c', '[ "$OLLAMA_HOST" = "127.0.0.1:11500" ]'], { OLLAMA_HOST: '127.0.0.1:11500' });
    expect(code).toBe(0);
  });
});
