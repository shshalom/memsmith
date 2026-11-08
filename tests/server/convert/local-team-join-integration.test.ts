// SPDX-License-Identifier: Apache-2.0
//
// Opt-in integration test against a throwaway embedded Postgres:
//   MEMSMITH_TEST_LOCAL_TEAM_PG=1 bun test tests/server/convert/local-team-join-integration.test.ts
//
// Every local project shares one local team. When they also shared that
// team's one key, postgres-auth scoped every project to the project the key
// was minted for, and a join of that project moved the key out from under
// the rest.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const OPT_IN = process.env.MEMSMITH_TEST_LOCAL_TEAM_PG === '1';
const PG_PORT = 55462;

if (OPT_IN) {
  if (String(PG_PORT) === '55433') throw new Error('BUG: PG_PORT matches the dogfood Postgres port');

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ms-local-team-pg-')));
  if (base.includes('/.memsmith')) throw new Error('BUG: test dir points into ~/.memsmith');
  const savedDataDir = process.env.MEMSMITH_DATA_DIR;
  process.env.MEMSMITH_DATA_DIR = join(base, 'data');

  let manager: import('../../../src/server/runtime/EmbeddedPostgresManager.js').EmbeddedPostgresManager;
  let pool: import('pg').Pool;
  let store: import('../../../src/services/identity/credential-store.js').CredentialStore;
  const dirA = join(base, 'alpha');
  const dirB = join(base, 'beta');
  const JOINED_TEAM = `team-joined-${randomUUID()}`;
  const TEAM_KEY = `msk_team_${randomUUID()}`;

  async function authenticate(key: string, projectId: string): Promise<{ teamId: string | null; projectId: string | null } | null> {
    const { requirePostgresServerAuth } = await import('../../../src/server/middleware/postgres-auth.js');
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, host: '127.0.0.1' };
    const req = {
      header: (name: string) => headers[name.toLowerCase()],
      query: { projectId },
      body: { projectId },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      path: '/v1/search',
    } as never as { authContext?: { teamId: string | null; projectId: string | null } };
    let status = 200;
    const res = { status: (code: number) => { status = code; return res; }, json: () => res, setHeader: () => res };
    await new Promise<void>((resolve) => {
      requirePostgresServerAuth(pool as never, { authMode: 'api-key' })(req as never, res as never, () => resolve());
      setTimeout(resolve, 2000);
    });
    return status === 200 && req.authContext ? { teamId: req.authContext.teamId, projectId: req.authContext.projectId } : null;
  }

  async function hookKey(cwd: string): Promise<string> {
    const { buildServerContext } = await import('../../../src/services/hooks/runtime-selector.js');
    const ctx = buildServerContext({ cwd, credentialStore: store, serverBaseUrlOverride: 'http://127.0.0.1:9' });
    expect(ctx).not.toBeNull();
    return (ctx!.client as unknown as { apiKey: string }).apiKey;
  }

  async function localViewerKey(projectId: string): Promise<string | null> {
    const { hashApiKey } = await import('../../../src/services/hooks/server-bootstrap.js');
    const r = await pool.query('SELECT key_hash FROM api_keys WHERE project_id = $1', [projectId]);
    const hashes = new Set(r.rows.map((row: { key_hash: string }) => row.key_hash));
    return store.listKeys().find((key) => hashes.has(hashApiKey(key))) ?? null;
  }

  beforeAll(async () => {
    const { EmbeddedPostgresManager } = await import('../../../src/server/runtime/EmbeddedPostgresManager.js');
    const { bootstrapServerPostgresSchema } = await import('../../../src/storage/postgres/schema.js');
    const { CredentialStore } = await import('../../../src/services/identity/credential-store.js');
    const { ensureProjectIdentity } = await import('../../../src/services/identity/project-identity.js');
    const pg = (await import('pg')).default;
    mkdirSync(join(base, 'pg'), { recursive: true });
    manager = new EmbeddedPostgresManager({
      paths: {
        binariesDir: join(homedir(), '.memsmith', 'pg-binaries'),
        dataDir: join(base, 'pg', 'data'),
        pidFile: join(base, 'pg', 'pg.pid'),
      },
      port: PG_PORT,
    });
    const { connectionString } = await manager.start();
    pool = new pg.Pool({ connectionString, max: 4 });
    await bootstrapServerPostgresSchema(pool as never);
    store = new CredentialStore(join(base, 'credentials.json'));
    mkdirSync(dirA);
    mkdirSync(dirB);
    await ensureProjectIdentity(pool as never, dirA, store);
    await ensureProjectIdentity(pool as never, dirB, store);
  }, 120_000);

  afterAll(async () => {
    try { await pool?.end(); } catch { /* best effort */ }
    try { await manager?.stop(); } catch { /* best effort */ }
    process.env.MEMSMITH_DATA_DIR = savedDataDir;
    rmSync(base, { recursive: true, force: true });
  });

  describe('projects in the shared local team (real Postgres)', () => {
    it('each authenticate as their own project', async () => {
      const { readProjectMarker } = await import('../../../src/services/identity/project-identity.js');
      const a = readProjectMarker(dirA)!;
      const b = readProjectMarker(dirB)!;
      expect(a.teamId).toBe(b.teamId);
      expect(await authenticate(await hookKey(dirA), a.projectId)).toEqual({ teamId: a.teamId, projectId: a.projectId });
      expect(await authenticate(await hookKey(dirB), b.projectId)).toEqual({ teamId: b.teamId, projectId: b.projectId });
    });

    it('keep authenticating after one of them joins a team', async () => {
      const { readProjectMarker, writeProjectRuntime } = await import('../../../src/services/identity/project-identity.js');
      const { repointLocalKeyToTeam } = await import('../../../src/server/convert/repoint-local-key.js');
      const a = readProjectMarker(dirA)!;
      const b = readProjectMarker(dirB)!;
      const localTeam = a.teamId;

      await repointLocalKeyToTeam(pool as never, JOINED_TEAM, a.projectId);
      store.storeKeyForTeam(JOINED_TEAM, TEAM_KEY);
      writeProjectRuntime(dirA, { runtime: 'server', serverUrl: 'https://team.example', teamId: JOINED_TEAM });

      expect(await authenticate(await hookKey(dirB), b.projectId)).toEqual({ teamId: localTeam, projectId: b.projectId });
      expect(await hookKey(dirA)).toBe(TEAM_KEY);
      const viewerKey = await localViewerKey(a.projectId);
      expect(viewerKey).not.toBeNull();
      expect(await authenticate(viewerKey!, a.projectId)).toEqual({ teamId: JOINED_TEAM, projectId: a.projectId });
    });
  });
}
