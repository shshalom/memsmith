import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../src/services/identity/credential-store.js';

describe('CredentialStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'memsmith-cred-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('store then resolve round-trips a key', () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    expect(store.resolveKeyForTeam('team-a')).toBeNull();
    store.storeKeyForTeam('team-a', 'msk_secret_a');
    expect(store.resolveKeyForTeam('team-a')).toBe('msk_secret_a');
  });

  it('writes the file with 0600 permissions', () => {
    const path = join(dir, 'credentials.json');
    const store = new CredentialStore(path);
    store.storeKeyForTeam('team-a', 'msk_secret_a');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps multiple teams independent', () => {
    const store = new CredentialStore(join(dir, 'credentials.json'));
    store.storeKeyForTeam('team-a', 'msk_a');
    store.storeKeyForTeam('team-b', 'msk_b');
    expect(store.resolveKeyForTeam('team-a')).toBe('msk_a');
    expect(store.resolveKeyForTeam('team-b')).toBe('msk_b');
  });

  it('resolve returns null for unknown team and when file absent', () => {
    const store = new CredentialStore(join(dir, 'nope.json'));
    expect(store.resolveKeyForTeam('team-x')).toBeNull();
  });
});
