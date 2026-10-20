// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  legacyGenerationPins,
  pinLegacyGenerationSettings,
} from '../../../src/server/settings/pin-legacy-generation-settings.js';

describe('legacyGenerationPins', () => {
  it('legacy install with only MEMSMITH_PROVIDER=ollama and MEMSMITH_OLLAMA_MODEL=qwen2.5:14b is pinned to ollama/qwen2.5:14b', () => {
    expect(legacyGenerationPins(
      { MEMSMITH_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b' },
      {},
    )).toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' });
  });

  it('pins the model the legacy install actually runs', () => {
    expect(legacyGenerationPins({ MEMSMITH_OLLAMA_MODEL: 'llama3.1:8b' }, {}))
      .toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'llama3.1:8b' });
  });

  it('pins the old registry default model when the legacy install never set one', () => {
    expect(legacyGenerationPins({ MEMSMITH_CONTEXT_OBSERVATIONS: '50' }, {}))
      .toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' });
  });

  it('an Ollama install with no generation model is pinned to the model it ran on main', () => {
    expect(legacyGenerationPins({ MEMSMITH_SERVER_PROVIDER: 'ollama' }, {}))
      .toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' });
    expect(legacyGenerationPins({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'llama3.1:8b' }, {}))
      .toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'llama3.1:8b' });
  });

  it('an Ollama install that names its model is not pinned', () => {
    expect(legacyGenerationPins({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'mistral:7b' }, {})).toBeNull();
  });

  it('install that already set MEMSMITH_SERVER_PROVIDER is not pinned', () => {
    expect(legacyGenerationPins(
      { MEMSMITH_SERVER_PROVIDER: 'claude', MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b' },
      {},
    )).toBeNull();
  });

  it('env override is not pinned', () => {
    expect(legacyGenerationPins(
      { MEMSMITH_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b' },
      { MEMSMITH_SERVER_PROVIDER: 'claude' },
    )).toBeNull();
  });

  it('empty settings (fresh machine) is not pinned', () => {
    expect(legacyGenerationPins({}, {})).toBeNull();
  });
});

describe('pinLegacyGenerationSettings', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ms-pin-'));
    path = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the pins once, keeping every existing key', () => {
    writeFileSync(path, JSON.stringify({ MEMSMITH_PROVIDER: 'ollama', MEMSMITH_GEMINI_API_KEY: 'k' }));

    expect(pinLegacyGenerationSettings({ path, env: {} }))
      .toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      MEMSMITH_PROVIDER: 'ollama',
      MEMSMITH_GEMINI_API_KEY: 'k',
      MEMSMITH_SERVER_PROVIDER: 'ollama',
      MEMSMITH_SERVER_MODEL: 'qwen2.5:14b',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(pinLegacyGenerationSettings({ path, env: {} })).toBeNull();
  });

  it('unwraps a legacy env-nested settings file', () => {
    writeFileSync(path, JSON.stringify({ env: { MEMSMITH_OLLAMA_MODEL: 'mistral:7b' } }));

    pinLegacyGenerationSettings({ path, env: {} });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      MEMSMITH_OLLAMA_MODEL: 'mistral:7b',
      MEMSMITH_SERVER_PROVIDER: 'ollama',
      MEMSMITH_SERVER_MODEL: 'mistral:7b',
    });
  });

  it('does not create a settings file on a fresh machine', () => {
    expect(pinLegacyGenerationSettings({ path, env: {} })).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it('leaves an unparseable settings file untouched', () => {
    writeFileSync(path, '{not json');
    expect(pinLegacyGenerationSettings({ path, env: {} })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('{not json');
  });
});

// USER_SETTINGS_PATH and loadFromFileOnce are frozen per process, so the real
// boot order runs in a child process with its own empty data dir.
describe('boot order on a fresh machine', () => {
  const root = resolve(import.meta.dir, '../../..');

  function runBoot(dataDir: string) {
    const script = `
      const { pinLegacyGenerationSettings } = await import(${JSON.stringify(join(root, 'src/server/settings/pin-legacy-generation-settings.ts'))});
      const { readBootGenerationSettings } = await import(${JSON.stringify(join(root, 'src/server/runtime/create-server-service.ts'))});
      const first = pinLegacyGenerationSettings();
      readBootGenerationSettings();
      const second = pinLegacyGenerationSettings();
      console.log(JSON.stringify({ first, second }));
    `;
    const env: Record<string, string> = { ...(process.env as Record<string, string>), MEMSMITH_DATA_DIR: dataDir };
    delete env.MEMSMITH_SERVER_PROVIDER;
    const proc = Bun.spawnSync([process.execPath, '-e', script], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const out = proc.stdout.toString().trim().split('\n').pop() ?? '';
    expect(proc.exitCode).toBe(0);
    return JSON.parse(out) as { first: unknown; second: unknown };
  }

  it('pin, then the boot settings read, then pin again leaves a fresh machine unpinned', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ms-fresh-'));
    try {
      expect(runBoot(dataDir)).toEqual({ first: null, second: null });
      expect(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).MEMSMITH_SERVER_PROVIDER).toBe('claude');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a settings file written by an older version is still pinned on the same boot path', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ms-legacy-'));
    try {
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ MEMSMITH_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b' }));
      expect(runBoot(dataDir).first).toEqual({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
