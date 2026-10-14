import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installedPluginVersion } from '../../src/npx-cli/utils/paths.js';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  applyRepairs,
  collectChecks,
  generationCheck,
  type DoctorProbes,
  type GenerationStatus,
  parseDoctorArgs,
  runDoctorCommand,
  planRepairs,
  versionMismatchStatus,
  type DoctorState,
} from '../../src/npx-cli/commands/doctor.js';

const healthy: DoctorState = {
  pidFileStale: false, portInUse: true, depsMissing: false,
  serverReachable: true, serverVersion: '13.10.2', pluginVersion: '13.10.2', remote: false,
};

describe('planRepairs', () => {
  it('plans nothing for a healthy install', () => {
    expect(planRepairs(healthy)).toEqual([]);
  });

  it('removes stale state only when nothing listens on the port', () => {
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: false, serverReachable: false }))
      .toEqual(['remove-stale-state', 'start']);
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: true })).not.toContain('remove-stale-state');
  });

  it('restarts a server running an older version', () => {
    expect(planRepairs({ ...healthy, serverVersion: '13.10.1' })).toEqual(['restart']);
  });

  it('installs missing dependencies before starting', () => {
    expect(planRepairs({ ...healthy, depsMissing: true, serverReachable: false, portInUse: false }))
      .toEqual(['install-deps', 'start']);
  });

  it('never removes state for a remote server, even with a stale pid file and a free port', () => {
    expect(planRepairs({ ...healthy, remote: true, pidFileStale: true, portInUse: false })).toEqual([]);
  });

  it('plans no server repair for a remote server', () => {
    expect(planRepairs({ ...healthy, remote: true, serverReachable: false })).toEqual([]);
  });
});

describe('applyRepairs', () => {
  it('stops at the first failed repair and names it', async () => {
    const ran: string[] = [];
    const result = await applyRepairs(['install-deps', 'start'], {
      removeState: () => ran.push('remove'),
      installDeps: async () => { ran.push('deps'); throw new Error('npm failed'); },
      lifecycle: async (c) => { ran.push(c); return 0; },
      out: () => {},
      ollama: async () => true,
    });
    expect(result).toEqual({ ok: false, failed: 'install-deps', error: 'npm failed' });
    expect(ran).toEqual(['deps']);
  });

  it('treats a nonzero lifecycle exit as a failure', async () => {
    const result = await applyRepairs(['start'], {
      removeState: () => {}, installDeps: async () => {}, lifecycle: async () => 1, out: () => {}, ollama: async () => true,
    });
    expect(result).toMatchObject({ ok: false, failed: 'start' });
  });
});

describe('parseDoctorArgs', () => {
  it('runs read-only checks with no arguments', () => {
    expect(parseDoctorArgs([])).toEqual({ kind: 'run', fix: false });
  });

  it('enables repairs only for --fix', () => {
    expect(parseDoctorArgs(['--fix'])).toEqual({ kind: 'run', fix: true });
  });

  it('prints help without running anything for --help and -h, even next to --fix', () => {
    expect(parseDoctorArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseDoctorArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseDoctorArgs(['--fix', '--help'])).toEqual({ kind: 'help' });
  });

  it('rejects unknown flags instead of ignoring them', () => {
    expect(parseDoctorArgs(['--force'])).toEqual({ kind: 'unknown', flag: '--force' });
    expect(parseDoctorArgs(['--fix', '--force'])).toEqual({ kind: 'unknown', flag: '--force' });
  });
});

describe('versionMismatchStatus', () => {
  it('warns on a plain read-only mismatch', () => {
    expect(versionMismatchStatus({ restarted: false })).toBe('warn');
  });

  it('fails when a restart did not converge', () => {
    expect(versionMismatchStatus({ restarted: true })).toBe('fail');
  });
});

describe('installedPluginVersion', () => {
  it('prefers the marketplace plugin.json over the running package', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-market-'));
    mkdirSync(join(root, 'plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
    expect(installedPluginVersion(root, () => '1.0.0')).toBe('9.9.9');
  });

  it('falls back when the marketplace plugin.json is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-market-'));
    expect(installedPluginVersion(root, () => '1.0.0')).toBe('1.0.0');
  });
});

describe('doctor server address', () => {
  function settingsWith(url: string): string {
    const path = join(mkdtempSync(join(tmpdir(), 'ms-doc-')), 'settings.json');
    writeFileSync(path, JSON.stringify({ MEMSMITH_SERVER_URL: url }));
    return path;
  }

  afterEach(() => { spyOn(process, 'exit').mockRestore(); spyOn(console, 'error').mockRestore(); });

  it('treats the remote server a team install configured as remote', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ms-doc-empty-'));
    const probed: string[] = [];
    const probes: DoctorProbes = {
      probeVersion: () => '1.0.0',
      isPluginInstalled: () => true,
      marketplaceDirectory: () => empty,
      installedPluginVersion: () => '13.10.2',
      probeServerHealth: async (baseUrl) => { probed.push(baseUrl); return { reachable: false }; },
      readServerPidFile: () => null,
      verifyPidFileOwnership: () => true,
      isPortInUse: async (host) => { probed.push(`port:${host}`); return false; },
      dataDir: () => empty,
      generation: async () => ({ provider: 'ollama', ollama: 'ready', model: 'qwen2.5:14b', origin: 'http://localhost:11434' }),
    };
    const { state } = await collectChecks(false, false, { settingsPath: settingsWith('https://team.example.com'), env: {} }, probes);
    expect(state.remote).toBe(true);
    expect(probed).toEqual(['https://team.example.com']);
  });

  it('exits 1 with a one-line message for a malformed URL', async () => {
    const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
    const errors: string[] = [];
    spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
    await expect(runDoctorCommand([], { settingsPath: settingsWith('not a url'), env: {} })).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors).toEqual(['Invalid MEMSMITH_SERVER_URL: not a url']);
  });
});

// `memsmith doctor` reported a healthy install on machines where generation
// could never run (Ollama missing, model not pulled, or no API key), so nothing
// was ever remembered and doctor said all was well.
describe('doctor Generation check', () => {
  const ollama = (state: 'ready' | 'model-missing' | 'not-running' | 'not-installed'): GenerationStatus =>
    ({ provider: 'ollama', ollama: state, model: 'qwen2.5:14b', origin: 'http://localhost:11434' });

  it('passes when Ollama has the model', () => {
    expect(generationCheck(ollama('ready'), false)).toMatchObject({ name: 'Generation', status: 'ok', required: true });
  });

  it('fails with the pull command when the model is missing', () => {
    const check = generationCheck(ollama('model-missing'), false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('ollama pull qwen2.5:14b');
  });

  it('fails with a start hint when Ollama is installed but not running', () => {
    const check = generationCheck(ollama('not-running'), false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('memsmith doctor --fix');
  });

  it('fails with an install link when Ollama is not installed', () => {
    const check = generationCheck(ollama('not-installed'), false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('https://ollama.com/download');
  });

  it('fails when a hosted provider has no API key, naming the key', () => {
    const check = generationCheck({ provider: 'gemini', missingCredential: 'MEMSMITH_GEMINI_API_KEY in ~/.memsmith/settings.json' }, false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('MEMSMITH_GEMINI_API_KEY');
  });

  it('passes a hosted provider whose key is present without calling it', () => {
    expect(generationCheck({ provider: 'claude', missingCredential: null }, false).status).toBe('ok');
  });

  it('fails on a provider name generation does not know', () => {
    expect(generationCheck({ provider: null, configured: 'gpt' }, false).status).toBe('fail');
  });

  it('does not judge local generation for a remote team server', () => {
    expect(generationCheck(ollama('not-installed'), true).status).toBe('warn');
  });
});

describe('planRepairs for generation', () => {
  const withOllama = (ollamaState: 'ready' | 'model-missing' | 'not-running' | 'not-installed'): DoctorState =>
    ({ ...healthy, generation: { provider: 'ollama', ollama: ollamaState, model: 'qwen2.5:14b', origin: 'http://localhost:11434' } });

  it('pulls a missing model', () => {
    expect(planRepairs(withOllama('model-missing'))).toEqual(['pull-ollama-model']);
  });

  it('starts an installed Ollama that is not running, then makes sure the model is there', () => {
    expect(planRepairs(withOllama('not-running'))).toEqual(['start-ollama', 'pull-ollama-model']);
  });

  it('never installs Ollama', () => {
    expect(planRepairs(withOllama('not-installed'))).toEqual([]);
  });

  it('plans nothing when generation is ready or uses a hosted provider', () => {
    expect(planRepairs(withOllama('ready'))).toEqual([]);
    expect(planRepairs({ ...healthy, generation: { provider: 'gemini', missingCredential: 'x' } })).toEqual([]);
  });

  it('leaves a remote team server alone', () => {
    expect(planRepairs({ ...withOllama('model-missing'), remote: true })).toEqual([]);
  });
});

describe('applyRepairs for generation', () => {
  it('routes Ollama repairs to the Ollama runner and stops when one fails', async () => {
    const ran: string[] = [];
    const result = await applyRepairs(['start-ollama', 'pull-ollama-model'], {
      removeState: () => {}, installDeps: async () => {}, lifecycle: async () => 0, out: () => {},
      ollama: async (action) => { ran.push(action); return action !== 'start'; },
    });
    expect(ran).toEqual(['start']);
    expect(result).toMatchObject({ ok: false, failed: 'start-ollama' });
  });

  it('pulls the model after starting Ollama', async () => {
    const ran: string[] = [];
    const result = await applyRepairs(['start-ollama', 'pull-ollama-model'], {
      removeState: () => {}, installDeps: async () => {}, lifecycle: async () => 0, out: () => {},
      ollama: async (action) => { ran.push(action); return true; },
    });
    expect(ran).toEqual(['start', 'pull']);
    expect(result).toEqual({ ok: true });
  });
});
