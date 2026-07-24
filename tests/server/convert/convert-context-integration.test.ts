// SPDX-License-Identifier: Apache-2.0
//
// Integration proof: ensureBaseKey mints a team key against the destination DB,
// caches it in a CredentialStore, and is idempotent (second call returns the
// same key and leaves exactly one api_keys row).
//
// Guard pattern mirrors tests/server/server-service.test.ts:16,62 and
// tests/server/convert/scoped-convert-integration.test.ts:
//   const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;
//   if (TEST_DATABASE_URL) { it('...', ...) }
// When the env var is unset, NO test is registered → clean skip, no crash.

import { describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bootstrapServerPostgresSchema,
} from '../../../src/storage/postgres/index.js';
import { ensureBaseKey, upsertTeamAndProject } from '../../../src/services/identity/project-identity.js';
import { hashApiKey } from '../../../src/services/hooks/server-bootstrap.js';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';

const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;

describe('convert-context mint (integration)', () => {
  if (TEST_DATABASE_URL) {
    it('mints a team key against the destination and caches it', async () => {
      // Use a temp file so we never touch ~/.memsmith/credentials.json
      const credPath = path.join(os.tmpdir(), `memsmith-test-creds-${randomUUID()}.json`);
      const store = new CredentialStore(credPath);

      // Use unique IDs per run so parallel runs and repeated runs never collide
      const teamId = randomUUID();
      const projectId = randomUUID();

      const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
      try {
        // Exercise the REAL production sequence: bootstrap schema → upsertTeamAndProject → ensureBaseKey.
        // This proves a fresh (empty) destination DB works end-to-end without manual seed rows.
        await bootstrapServerPostgresSchema(pool);
        await upsertTeamAndProject(pool, teamId, projectId);

        // --- First call: mints a fresh key ---
        const key1 = await ensureBaseKey(pool, teamId, projectId, store);

        // The store must now resolve the key for this team
        expect(store.resolveKeyForTeam(teamId)).toBe(key1);

        // api_keys must have exactly one row for this team_id
        const countResult1 = await pool.query<{ count: string }>(
          'SELECT count(*) FROM api_keys WHERE team_id = $1',
          [teamId],
        );
        expect(Number(countResult1.rows[0]!.count)).toBe(1);

        // The stored hash must match the key we received
        const expectedHash = hashApiKey(key1);
        const hashResult = await pool.query<{ key_hash: string }>(
          'SELECT key_hash FROM api_keys WHERE team_id = $1',
          [teamId],
        );
        expect(hashResult.rows[0]!.key_hash).toBe(expectedHash);

        // --- Idempotency: second call must return the SAME key ---
        const key2 = await ensureBaseKey(pool, teamId, projectId, store);
        expect(key2).toBe(key1);

        // Still exactly one row for this team — no duplicate was inserted
        const countResult2 = await pool.query<{ count: string }>(
          'SELECT count(*) FROM api_keys WHERE team_id = $1',
          [teamId],
        );
        expect(Number(countResult2.rows[0]!.count)).toBe(1);
      } finally {
        await pool.end();
      }
    });
  }
});
