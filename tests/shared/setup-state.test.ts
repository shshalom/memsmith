import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isSetupNeeded,
  readSetupMarkers,
  writeSetupComplete,
  writeSetupPending,
  MARKETPLACE_SETUP_DIRECTIVE,
} from '../../src/shared/setup-state.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const base = { pending: true, complete: false, rawSettings: { MEMSMITH_RUNTIME: 'local' }, env: {} };

describe('isSetupNeeded', () => {
  it('is true only for a server-created settings file with no provider chosen', () => {
    expect(isSetupNeeded(base)).toBe(true);
  });

  it('never asks an existing install, which has no pending marker', () => {
    expect(isSetupNeeded({ ...base, pending: false, rawSettings: null })).toBe(false);
  });

  it('stops asking once the installer has run or a provider is chosen', () => {
    expect(isSetupNeeded({ ...base, complete: true })).toBe(false);
    expect(isSetupNeeded({ ...base, rawSettings: { MEMSMITH_SERVER_PROVIDER: 'ollama' } })).toBe(false);
    expect(isSetupNeeded({ ...base, rawSettings: { MEMSMITH_PROVIDER: 'claude' } })).toBe(false);
    expect(isSetupNeeded({ ...base, env: { MEMSMITH_SERVER_PROVIDER: 'gemini' } })).toBe(false);
  });

  it('ignores blank provider values', () => {
    expect(isSetupNeeded({ ...base, rawSettings: { MEMSMITH_SERVER_PROVIDER: ' ' }, env: { MEMSMITH_SERVER_PROVIDER: '' } })).toBe(true);
  });
});

describe('setup markers', () => {
  it('the server marks setup pending when it creates settings.json from its defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-setup-'));
    try {
      SettingsDefaultsManager.loadFromFile(join(dir, 'settings.json'));
      expect(readSetupMarkers(dir)).toEqual({ pending: true, complete: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an existing settings.json never gets the pending marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-setup-'));
    try {
      require('fs').writeFileSync(join(dir, 'settings.json'), JSON.stringify({ MEMSMITH_RUNTIME: 'local' }));
      SettingsDefaultsManager.loadFromFile(join(dir, 'settings.json'));
      expect(readSetupMarkers(dir).pending).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('completing setup clears the pending marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-setup-'));
    try {
      writeSetupPending(dir);
      writeSetupComplete(dir);
      expect(readSetupMarkers(dir)).toEqual({ pending: false, complete: true });
      expect(existsSync(join(dir, '.setup-pending'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MARKETPLACE_SETUP_DIRECTIVE', () => {
  it('keeps API keys out of chat and restarts only after the install finishes', () => {
    expect(MARKETPLACE_SETUP_DIRECTIVE).toContain('Never ask for the API key in chat');
    expect(MARKETPLACE_SETUP_DIRECTIVE).toContain('When the install command has finished, run `npx --yes memsmith@latest restart`');
  });
});
