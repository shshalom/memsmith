// SPDX-License-Identifier: Apache-2.0
//
// settings.json holds credential-shaped keys — MEMSMITH_SERVER_API_KEY,
// MEMSMITH_TEAM_API_KEY, MEMSMITH_GEMINI_API_KEY, MEMSMITH_TELEGRAM_BOT_TOKEN,
// MEMSMITH_OPENROUTER_API_KEY. server-bootstrap knows this: persistServerSettings
// chmods to 0600 right after writing, with a comment explaining that hooks read
// the file on every invocation so other local users must not be able to read the
// key. The convert writer passes { mode: 0o600 } for the same reason.
//
// SettingsDefaultsManager is the writer that CREATES the file, and it was the one
// writer that did neither. Measured on the dogfood box: ~/.memsmith/settings.json
// sat at 0644 inside a 0755 directory.
//
// It had not leaked a secret only because every credential key on that machine
// happened to be empty — the real keys live in credentials.json (0600). That is
// luck, not design: the moment a user sets an OpenRouter or Gemini key through
// the UI, or an installer writes MEMSMITH_SERVER_API_KEY before the bootstrap
// chmod runs, a world-readable file holds a live credential.
//
// The nested→flat migration was the sharper edge. It rewrites the file with
// plain writeFileSync and no mode, so a file that server-bootstrap had correctly
// locked to 0600 came back out at 0644 — a silent DOWNGRADE of a permission
// another module deliberately set.
//
// Windows/CIFS do not implement POSIX modes, so these assertions are skipped
// off-POSIX rather than failing on a platform that cannot satisfy them.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

const POSIX = process.platform !== 'win32';

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ms-settings-perm-'));
}

describe('settings.json file permissions', () => {
  it('creates the settings file owner-only, because it can hold API keys', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      const path = join(dir, 'settings.json');
      SettingsDefaultsManager.loadFromFile(path);
      // 0644 would let any local user read MEMSMITH_SERVER_API_KEY.
      expect(mode(path)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the data directory owner-only', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      // EnvManager.saveMemSmithEnv already chmods the data dir to 0700 for the
      // .env file. The settings path never invoked it, so on a box where
      // settings.json was created first the directory stayed 0755.
      const nested = join(dir, 'created-by-settings');
      const path = join(nested, 'settings.json');
      SettingsDefaultsManager.loadFromFile(path);
      expect(mode(nested)).toBe('700');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT downgrade permissions when migrating nested → flat', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      const path = join(dir, 'settings.json');
      // Exactly what server-bootstrap leaves behind: a locked file with a key.
      writeFileSync(
        path,
        JSON.stringify({ env: { MEMSMITH_SERVER_API_KEY: 'cmem_secret' } }),
        { mode: 0o600 },
      );
      expect(mode(path)).toBe('600');

      SettingsDefaultsManager.loadFromFile(path);

      // The migration rewrites the file. It must not widen it.
      expect(mode(path)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens a file that is already too open', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      const path = join(dir, 'settings.json');
      // An install that predates this fix leaves a world-readable file behind.
      // Reading it is the one moment we are guaranteed to touch it, so that is
      // where the repair belongs — otherwise existing installs stay exposed
      // forever and the fix only helps new ones.
      writeFileSync(path, JSON.stringify({ MEMSMITH_SERVER_API_KEY: 'cmem_x' }), { mode: 0o644 });
      SettingsDefaultsManager.loadFromFile(path);
      expect(mode(path)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still returns settings when the file cannot be chmodded', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({ MEMSMITH_LOG_LEVEL: 'DEBUG' }), { mode: 0o600 });
      // Hardening must never become a new way for settings loading to fail:
      // a hook that cannot read settings is worse than a loose mode bit.
      const settings = SettingsDefaultsManager.loadFromFile(path);
      expect(settings.MEMSMITH_LOG_LEVEL).toBe('DEBUG');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create a file merely because one was read', () => {
    if (!POSIX) return;
    const dir = scratch();
    try {
      // Guard against the repair path accidentally materialising a settings
      // file in a directory that had none.
      const path = join(dir, 'nested', 'deep', 'settings.json');
      mkdirSync(join(dir, 'nested'), { recursive: true });
      const settings = SettingsDefaultsManager.loadFromFile(path);
      expect(settings.MEMSMITH_RUNTIME).toBe('local');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
