// SPDX-License-Identifier: Apache-2.0
//
// Item 3 (2026-07-27 local-fresh-install-readiness) — GET /v1/projects.
//
// Loopback-gated (same 3-part gate already shipped for the viewer cookie) and
// lists ONLY projects this machine holds a key for (DB projects joined
// against CredentialStore) — never every project in the database. This
// mirrors the cookie rule exactly, so the switcher can never offer a project
// it cannot actually open.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Pool } from 'pg';
import express from 'express';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { registerProjectsRoutes } from '../../src/server/routes/v1/settingsRoutes.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { upsertTeamAndProject } from '../../src/services/identity/project-identity.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });

const TEAM_A = 'team-v1-projects-a';
const PROJECT_A = 'project-v1-projects-a';
const TEAM_B = 'team-v1-projects-b';
const PROJECT_B = 'project-v1-projects-b';
const TEAM_UNKEYED = 'team-v1-projects-unkeyed';
const PROJECT_UNKEYED = 'project-v1-projects-unkeyed';

// Loopback headers matching the real gate: isLocalhost && hasLoopbackHostHeader && !hasForwardedClientHeaders.
const LOOPBACK_HEADERS = { Host: '127.0.0.1' };
const FORWARDED_HEADERS = { Host: '127.0.0.1', 'X-Forwarded-For': '203.0.113.5' };

function appWith(opts: {
  credentialStore: CredentialStore;
  serverCwd?: string;
  authProjectId?: string | null;
}) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.authContext = opts.authProjectId ? { projectId: opts.authProjectId, scopes: ['*'] } : { scopes: ['*'] };
    next();
  });
  const originalCwd = process.env.MEMSMITH_PROJECT_CWD;
  if (opts.serverCwd) process.env.MEMSMITH_PROJECT_CWD = opts.serverCwd;
  registerProjectsRoutes(app, { pool, credentialStore: opts.credentialStore });
  return { app, restoreCwd: () => { process.env.MEMSMITH_PROJECT_CWD = originalCwd; } };
}

async function startApp(app: express.Application) {
  return new Promise<{
    call: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const call = async (path: string, headers: Record<string, string> = LOOPBACK_HEADERS) => {
        const res = await fetch(`${base}${path}`, { headers });
        let json: any;
        try { json = await res.json(); } catch { json = null; }
        return { status: res.status, body: json };
      };
      const close = () => new Promise<void>((res, rej) => server.close((err) => err ? rej(err) : res()));
      resolve({ call, close });
    });
    server.on('error', reject);
  });
}

describe('GET /v1/projects', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await upsertTeamAndProject(pool, TEAM_A, PROJECT_A);
    await upsertTeamAndProject(pool, TEAM_B, PROJECT_B);
    await upsertTeamAndProject(pool, TEAM_UNKEYED, PROJECT_UNKEYED);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM projects WHERE id = ANY($1::text[])', [[PROJECT_A, PROJECT_B, PROJECT_UNKEYED]]);
    await pool.query('DELETE FROM teams WHERE id = ANY($1::text[])', [[TEAM_A, TEAM_B, TEAM_UNKEYED]]);
    await pool.end();
  });

  it('only lists projects this machine holds a key for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'msk_teama1234567890');
    store.storeKeyForTeam(TEAM_B, 'msk_teamb1234567890');
    // Deliberately no key stored for TEAM_UNKEYED.

    const { app } = appWith({ credentialStore: store });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      expect(res.status).toBe(200);
      const ids = (res.body as { projectId: string }[]).map(p => p.projectId);
      expect(ids).toContain(PROJECT_A);
      expect(ids).toContain(PROJECT_B);
      expect(ids).not.toContain(PROJECT_UNKEYED);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runtime reflects the current project\'s own marker; other projects fall back to local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'msk_teama1234567890');
    store.storeKeyForTeam(TEAM_B, 'msk_teamb1234567890');

    const serverCwd = mkdtempSync(join(tmpdir(), 'memsmith-projects-servercwd-'));
    mkdirSync(join(serverCwd, '.memsmith'), { recursive: true });
    writeFileSync(join(serverCwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: TEAM_A, projectId: PROJECT_A, runtime: 'server' }), 'utf-8');

    const { app, restoreCwd } = appWith({ credentialStore: store, serverCwd });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      expect(res.status).toBe(200);
      const byId = new Map((res.body as { projectId: string; runtime: string }[]).map(p => [p.projectId, p.runtime]));
      expect(byId.get(PROJECT_A)).toBe('team'); // this server's own marker says runtime: 'server' -> "team"
      expect(byId.get(PROJECT_B)).toBe('local'); // unreachable marker -> falls back to local
    } finally {
      await close();
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(serverCwd, { recursive: true, force: true });
    }
  });

  it('isCurrent matches authContext.projectId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'msk_teama1234567890');
    store.storeKeyForTeam(TEAM_B, 'msk_teamb1234567890');

    const { app } = appWith({ credentialStore: store, authProjectId: PROJECT_B });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      expect(res.status).toBe(200);
      const byId = new Map((res.body as { projectId: string; isCurrent: boolean }[]).map(p => [p.projectId, p.isCurrent]));
      expect(byId.get(PROJECT_A)).toBe(false);
      expect(byId.get(PROJECT_B)).toBe(true);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-loopback requests are refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'msk_teama1234567890');

    const { app } = appWith({ credentialStore: store });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects', FORWARDED_HEADERS);
      expect(res.status).toBe(403);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a machine holding no keys returns an empty list, not every project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    // No keys stored at all.

    const { app } = appWith({ credentialStore: store });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Projects are named after their folder at mint time. The route originally
  // selected only (id, team_id) and shortened the uuid for every project except
  // the server's own, which meant a real stored name was discarded — the
  // switcher kept showing uuids after naming already worked.
  it('shows a project\'s stored name, not a shortened uuid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'cmem_named_key');
    await pool.query('UPDATE projects SET name = $2 WHERE id = $1', [PROJECT_A, 'my-real-folder']);

    const { app } = appWith({ credentialStore: store });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      const entry = res.body.find((p: any) => p.projectId === PROJECT_A);
      expect(entry?.name).toBe('my-real-folder');
    } finally {
      // Restore the placeholder so sibling tests see the original fixture.
      await pool.query('UPDATE projects SET name = id WHERE id = $1', [PROJECT_A]);
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a short id when the name is still the placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-projects-route-'));
    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam(TEAM_A, 'cmem_named_key');
    // Fixture rows are seeded with name = id (the NOT NULL placeholder).

    const { app } = appWith({ credentialStore: store });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/projects');
      const entry = res.body.find((p: any) => p.projectId === PROJECT_A);
      expect(entry?.name).toBe(PROJECT_A.slice(0, 8));
      expect(entry?.name).not.toBe(PROJECT_A);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
