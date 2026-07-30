// SPDX-License-Identifier: Apache-2.0
//
// ensureBaseKey reads the credential cache, and if it finds nothing, mints a key
// and writes it. Several sessions starting together all pass that check before
// any of them writes, so each mints its own key and inserts its own api_keys row
// while the cache keeps only the last writer's.
//
// Measured before the fix: 5 concurrent starts for one team produced 5 DISTINCT
// keys and 5 api_keys rows, with 1 cached. The four orphans are not merely waste
// — each is a VALID credential whose plaintext exists nowhere, so it can neither
// be used nor identified in order to revoke it. The sessions holding them work
// until their process exits, then those keys are gone.
//
// The fix moves the decision into the store: storeKeyIfAbsent does check-and-set
// under the same cross-process lock, so exactly one candidate is adopted and
// every other caller gets the winner's key back. Crucially, ensureBaseKey then
// persists the hash of the ADOPTED key, not its own discarded candidate —
// inserting the loser's hash is what created the orphan rows.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';
import { ensureBaseKey } from '../../../src/services/identity/project-identity.js';

function fakePool() {
  const apiKeys: Array<{ hash: string; team: string }> = [];
  return {
    apiKeys,
    async query(text: string, values?: unknown[]) {
      if (/INSERT INTO api_keys/.test(text)) {
        apiKeys.push({ hash: String(values![1]), team: String(values![2]) });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT 1 FROM api_keys/.test(text)) {
        const hit = apiKeys.some(k => k.hash === String(values![0]) && k.team === String(values![1]));
        return { rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('ensureBaseKey under concurrent session starts', () => {
  for (const n of [2, 3, 5]) {
    it(`${n} concurrent starts adopt ONE key and leave no orphan credentials`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ms-mint-race-'));
      try {
        const credPath = join(dir, 'credentials.json');
        const pool = fakePool();
        const teamId = 'team-fixed';

        const keys = await Promise.all(
          Array.from({ length: n }, () =>
            ensureBaseKey(pool as never, teamId, 'proj-1', new CredentialStore(credPath)),
          ),
        );

        // Every session must end up holding the SAME key...
        expect(new Set(keys).size).toBe(1);
        // ...the cache must hold exactly that key...
        const cached = new CredentialStore(credPath).resolveKeyForTeam(teamId);
        expect(cached).toBe(keys[0]!);
        // ...and no orphan credential rows may exist.
        expect(pool.apiKeys).toHaveLength(1);
        expect(pool.apiKeys[0]!.team).toBe(teamId);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('persists the hash of the ADOPTED key, so the stored key validates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-mint-hash-'));
    try {
      const credPath = join(dir, 'credentials.json');
      const pool = fakePool();
      const { createHash } = await import('crypto');

      const keys = await Promise.all([
        ensureBaseKey(pool as never, 'team-x', 'proj-1', new CredentialStore(credPath)),
        ensureBaseKey(pool as never, 'team-x', 'proj-1', new CredentialStore(credPath)),
      ]);

      // A row whose hash does not match the cached plaintext authenticates
      // nothing — the server would reject the only key the machine still has.
      const expected = createHash('sha256').update(keys[0]!).digest('hex');
      expect(pool.apiKeys.map(k => k.hash)).toContain(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still returns the cached key when one already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-mint-cached-'));
    try {
      const credPath = join(dir, 'credentials.json');
      const pool = fakePool();
      const first = await ensureBaseKey(pool as never, 'team-y', 'proj-1', new CredentialStore(credPath));
      const second = await ensureBaseKey(pool as never, 'team-y', 'proj-1', new CredentialStore(credPath));
      expect(second).toBe(first);
      // The drift-repair path must not mint a second row for an unchanged key.
      expect(pool.apiKeys).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
