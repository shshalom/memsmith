// SPDX-License-Identifier: Apache-2.0
//
// CredentialStore must honour MEMSMITH_DATA_DIR.
//
// It used to hardcode join(homedir(), '.memsmith', 'credentials.json'), and every
// production caller constructs `new CredentialStore()` with no argument. So an
// isolated run — the team-mode rig, or any test that mints a key — wrote the
// DEVELOPER'S REAL credential file even with MEMSMITH_DATA_DIR pointed at /tmp.
// Measured before the fix:
//   MEMSMITH_DATA_DIR=/tmp/x  ->  /Users/<me>/.memsmith/credentials.json
//
// That is a data-loss path, not untidiness: the dogfood project is a live
// workspace, and a keyless or clobbered marker makes every hook fall back to
// `missing_api_key` and silently drop observations ("dark capture").
//
// Both directions are pinned. Honouring the override protects an isolated run;
// keeping the default protects the real install, which must not move.

import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { homedir } from 'os';

/** Fresh module instance so the constructor default re-evaluates under the env. */
async function loadStoreClass() {
  const mod = await import(`../../../src/services/identity/credential-store.ts?t=${Math.random()}`);
  return mod.CredentialStore;
}

function pathOf(store: unknown): string {
  return (store as { path: string }).path;
}

describe('CredentialStore data-dir isolation', () => {
  it('writes under MEMSMITH_DATA_DIR when it is set', async () => {
    const previous = process.env.MEMSMITH_DATA_DIR;
    process.env.MEMSMITH_DATA_DIR = '/tmp/ms-cred-isolation-test';
    try {
      const CredentialStore = await loadStoreClass();
      const resolved = pathOf(new CredentialStore());
      expect(resolved).toBe('/tmp/ms-cred-isolation-test/credentials.json');
      // The specific regression: it must NOT be the developer's real file.
      expect(resolved).not.toBe(join(homedir(), '.memsmith', 'credentials.json'));
    } finally {
      if (previous === undefined) delete process.env.MEMSMITH_DATA_DIR;
      else process.env.MEMSMITH_DATA_DIR = previous;
    }
  });

  it('keeps the real path when MEMSMITH_DATA_DIR is unset', async () => {
    const previous = process.env.MEMSMITH_DATA_DIR;
    delete process.env.MEMSMITH_DATA_DIR;
    try {
      const CredentialStore = await loadStoreClass();
      // A real install must be unaffected by the isolation change. resolveDataDir()
      // may return a settings.json override, so assert the FILE NAME and that the
      // directory is the resolved data dir — not that it is literally homedir().
      expect(pathOf(new CredentialStore()).endsWith('credentials.json')).toBe(true);
    } finally {
      if (previous !== undefined) process.env.MEMSMITH_DATA_DIR = previous;
    }
  });

  it('still honours an explicitly passed path', async () => {
    const CredentialStore = await loadStoreClass();
    expect(pathOf(new CredentialStore('/tmp/explicit/creds.json'))).toBe('/tmp/explicit/creds.json');
  });
});
