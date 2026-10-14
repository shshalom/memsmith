import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isSetupComplete,
  markerExists,
  writeSetupMarker,
  MARKETPLACE_SETUP_DIRECTIVE,
} from '../../src/shared/setup-state.js';

describe('isSetupComplete', () => {
  it('is false for a marketplace install: server defaults, no provider, no marker', () => {
    expect(isSetupComplete({ MEMSMITH_RUNTIME: 'local', MEMSMITH_SERVER_PORT: '38877' }, {}, false)).toBe(false);
    expect(isSetupComplete(null, {}, false)).toBe(false);
  });

  it('is true once the installer has run, whatever version wrote the settings', () => {
    expect(isSetupComplete({}, {}, true)).toBe(true);
    expect(isSetupComplete({ MEMSMITH_SERVER_PROVIDER: 'ollama' }, {}, false)).toBe(true);
    expect(isSetupComplete({ MEMSMITH_PROVIDER: 'claude' }, {}, false)).toBe(true);
  });

  it('is true when the environment chooses the provider', () => {
    expect(isSetupComplete(null, { MEMSMITH_SERVER_PROVIDER: 'gemini' }, false)).toBe(true);
  });

  it('ignores blank provider values', () => {
    expect(isSetupComplete({ MEMSMITH_SERVER_PROVIDER: '  ' }, { MEMSMITH_SERVER_PROVIDER: '' }, false)).toBe(false);
  });
});

describe('setup marker', () => {
  it('is written by the installer and read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-setup-'));
    try {
      expect(markerExists(dir)).toBe(false);
      writeSetupMarker(join(dir, 'nested'));
      expect(markerExists(join(dir, 'nested'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MARKETPLACE_SETUP_DIRECTIVE', () => {
  it('runs the real installer non-interactively and keeps API keys out of chat', () => {
    expect(MARKETPLACE_SETUP_DIRECTIVE).toContain('npx --yes memsmith@latest install --ide claude-code --provider ollama --setup-ollama');
    expect(MARKETPLACE_SETUP_DIRECTIVE).toContain('Never ask for the API key in chat');
    expect(MARKETPLACE_SETUP_DIRECTIVE).toContain('npx --yes memsmith@latest restart');
  });
});
