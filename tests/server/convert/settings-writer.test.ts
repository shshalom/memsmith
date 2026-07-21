import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeServerModeSettings } from '../../../src/server/convert/settings-writer.js';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-settings-')); path = join(dir, 'settings.json'); });
afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

describe('writeServerModeSettings', () => {
  it('merges into an existing settings file, preserving unrelated keys', () => {
    writeFileSync(path, JSON.stringify({ MEMSMITH_PROVIDER: 'ollama', MEMSMITH_RUNTIME: 'local' }));
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server', MEMSMITH_SERVER_DATABASE_URL: 'postgres://x' }, { path });
    const out = JSON.parse(readFileSync(path, 'utf8'));
    expect(out.MEMSMITH_PROVIDER).toBe('ollama');
    expect(out.MEMSMITH_RUNTIME).toBe('server');
    expect(out.MEMSMITH_SERVER_DATABASE_URL).toBe('postgres://x');
  });

  it('creates the file when absent', () => {
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server' }, { path });
    expect(JSON.parse(readFileSync(path, 'utf8')).MEMSMITH_RUNTIME).toBe('server');
  });

  it('treats a corrupt existing file as empty and still writes the patch', () => {
    writeFileSync(path, 'not json{{');
    writeServerModeSettings({ MEMSMITH_RUNTIME: 'server' }, { path });
    expect(JSON.parse(readFileSync(path, 'utf8')).MEMSMITH_RUNTIME).toBe('server');
  });
});
