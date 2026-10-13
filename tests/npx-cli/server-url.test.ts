import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveServerUrl } from '../../src/npx-cli/utils/server-url.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

function settingsFile(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ms-url-')), 'settings.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

describe('resolveServerUrl', () => {
  it('reads the URL a team install wrote to settings.json', () => {
    const settingsPath = settingsFile({ MEMSMITH_SERVER_URL: 'https://team.example.com' });
    expect(resolveServerUrl({ settingsPath, env: {} })).toBe('https://team.example.com');
  });

  it('reads the legacy env-nested settings shape', () => {
    const settingsPath = settingsFile({ env: { MEMSMITH_SERVER_URL: 'https://team.example.com' } });
    expect(resolveServerUrl({ settingsPath, env: {} })).toBe('https://team.example.com');
  });

  it('lets the environment override settings.json', () => {
    const settingsPath = settingsFile({ MEMSMITH_SERVER_URL: 'https://team.example.com' });
    expect(resolveServerUrl({ settingsPath, env: { MEMSMITH_SERVER_URL: 'http://127.0.0.1:40000' } })).toBe('http://127.0.0.1:40000');
  });

  it('falls back to the default without creating a missing settings file', () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), 'ms-url-')), 'settings.json');
    expect(resolveServerUrl({ settingsPath, env: {} })).toBe(SettingsDefaultsManager.getAllDefaults().MEMSMITH_SERVER_URL);
    expect(Bun.file(settingsPath).size).toBe(0);
  });
});
