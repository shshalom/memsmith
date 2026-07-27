import { describe, it, expect } from 'bun:test';
import { maskKey, buildIdentityPayload } from '../../src/server/routes/v1/identity-payload.js';
import { registerIdentityRoutes } from '../../src/server/routes/v1/settingsRoutes.js';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import type { AddressInfo } from 'net';

describe('identity payload', () => {
  it('maskKey shows only the last 4 chars', () => {
    expect(maskKey('msk_abcdefgh1234')).toBe('msk_••••••••1234');
    expect(maskKey('')).toBe('');
  });

  it('buildIdentityPayload reports keyPresent + masked, never plaintext unless revealed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-idp-'));
    const store = new CredentialStore(join(dir, 'c.json'));
    store.storeKeyForTeam('team-z', 'msk_secretzz1234');
    const payload = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: false });
    expect(payload.teamId).toBe('team-z');
    expect(payload.projectId).toBe('proj-z');
    expect(payload.keyPresent).toBe(true);
    expect(payload.keyMasked).toBe('msk_••••••••1234');
    expect((payload as any).keyPlaintext).toBeUndefined();
    const revealed = buildIdentityPayload({ teamId: 'team-z', projectId: 'proj-z' }, store, { reveal: true });
    expect(revealed.keyPlaintext).toBe('msk_secretzz1234');
    rmSync(dir, { recursive: true, force: true });
  });
});

// Item 1 (2026-07-27 local-fresh-install-readiness) — GET /v1/identity must
// report the REQUEST's project (req.authContext), not the server's cwd. One
// server serves every local project, so falling back to the server's own
// marker always showed the dogfood's identity regardless of which project's
// dashboard was open — and the Go Team wizard in Settings converts
// req.authContext.projectId, so displaying the wrong project there is unsafe.
describe('GET /v1/identity — request-scoped project (Item 1)', () => {
  // Build an app that injects a given authContext (or none) ahead of
  // registerIdentityRoutes, mirroring the real middleware ordering
  // (requirePostgresServerAuth populates req.authContext before the route runs).
  function appWith(opts: {
    authContext?: { teamId: string; projectId: string } | null;
    credentialStore: CredentialStore;
    serverCwd: string;
  }) {
    const app = express();
    app.use((req: any, _res, next) => {
      if (opts.authContext) {
        req.authContext = { ...opts.authContext, scopes: ['*'] };
      } else {
        req.authContext = { scopes: ['*'] }; // present but no team/project — must fall back
      }
      next();
    });
    const originalCwd = process.env.MEMSMITH_PROJECT_CWD;
    process.env.MEMSMITH_PROJECT_CWD = opts.serverCwd;
    registerIdentityRoutes(app, {
      credentialStore: opts.credentialStore,
      requireScopes: () => true,
    });
    return { app, restoreCwd: () => { process.env.MEMSMITH_PROJECT_CWD = originalCwd; } };
  }

  async function startApp(app: express.Application) {
    return new Promise<{ call: (path: string) => Promise<{ status: number; body: any }>; close: () => Promise<void> }>((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;
        const call = async (path: string) => {
          const res = await fetch(`${base}${path}`);
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

  it('authContext present → returns the REQUEST project, not the server cwd marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-identity-route-'));
    const serverCwd = mkdtempSync(join(tmpdir(), 'memsmith-identity-servercwd-'));
    mkdirSync(join(serverCwd, '.memsmith'), { recursive: true });
    writeFileSync(join(serverCwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'server-team', projectId: 'server-project' }), 'utf-8');

    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam('request-team', 'msk_requestteamkey1234');
    store.storeKeyForTeam('server-team', 'msk_serverteamkey1234');

    const { app, restoreCwd } = appWith({
      authContext: { teamId: 'request-team', projectId: 'request-project' },
      credentialStore: store,
      serverCwd,
    });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/identity');
      expect(res.status).toBe(200);
      expect(res.body.teamId).toBe('request-team');
      expect(res.body.projectId).toBe('request-project');
      // Never the server's own marker.
      expect(res.body.teamId).not.toBe('server-team');
      expect(res.body.projectId).not.toBe('server-project');
      // Security note: keyMasked derives from the REQUEST's teamId only.
      expect(res.body.keyPresent).toBe(true);
    } finally {
      await close();
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(serverCwd, { recursive: true, force: true });
    }
  });

  it('authContext absent (no team/project) → falls back to the server cwd marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-identity-route-'));
    const serverCwd = mkdtempSync(join(tmpdir(), 'memsmith-identity-servercwd-'));
    mkdirSync(join(serverCwd, '.memsmith'), { recursive: true });
    writeFileSync(join(serverCwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'server-team', projectId: 'server-project' }), 'utf-8');

    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam('server-team', 'msk_serverteamkey1234');

    const { app, restoreCwd } = appWith({
      authContext: null,
      credentialStore: store,
      serverCwd,
    });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/identity');
      expect(res.status).toBe(200);
      expect(res.body.teamId).toBe('server-team');
      expect(res.body.projectId).toBe('server-project');
    } finally {
      await close();
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(serverCwd, { recursive: true, force: true });
    }
  });

  it('no marker and no authContext → 404 unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-identity-route-'));
    const serverCwd = mkdtempSync(join(tmpdir(), 'memsmith-identity-nomark-'));
    // No .memsmith/project.json written — no marker exists.
    const store = new CredentialStore(join(dir, 'creds.json'));

    const { app, restoreCwd } = appWith({
      authContext: null,
      credentialStore: store,
      serverCwd,
    });
    const { call, close } = await startApp(app);
    try {
      const res = await call('/v1/identity');
      expect(res.status).toBe(404);
    } finally {
      await close();
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(serverCwd, { recursive: true, force: true });
    }
  });

  it('?reveal=true stays loopback-only regardless of which project is scoped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memsmith-identity-route-'));
    const serverCwd = mkdtempSync(join(tmpdir(), 'memsmith-identity-servercwd-'));
    mkdirSync(join(serverCwd, '.memsmith'), { recursive: true });
    writeFileSync(join(serverCwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'server-team', projectId: 'server-project' }), 'utf-8');

    const store = new CredentialStore(join(dir, 'creds.json'));
    store.storeKeyForTeam('request-team', 'msk_requestteamkey1234');

    const { app, restoreCwd } = appWith({
      authContext: { teamId: 'request-team', projectId: 'request-project' },
      credentialStore: store,
      serverCwd,
    });
    const { call, close } = await startApp(app);
    try {
      // The test harness calls via 127.0.0.1, which IS loopback, so reveal
      // should be honored here and scoped to the REQUEST team's key, not the
      // server's.
      const res = await call('/v1/identity?reveal=true');
      expect(res.status).toBe(200);
      expect(res.body.keyPlaintext).toBe('msk_requestteamkey1234');
    } finally {
      await close();
      restoreCwd();
      rmSync(dir, { recursive: true, force: true });
      rmSync(serverCwd, { recursive: true, force: true });
    }
  });
});
