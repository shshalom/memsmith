// SPDX-License-Identifier: Apache-2.0
//
// Task 3: the local-dev loopback bypass must adopt the REQUEST's own
// projectId (body, then query) when present, falling back to
// options.localDevProjectId otherwise. This makes authContext.projectId the
// ONE routing source for local-dev — a second local project on a shared
// server can route to its own database without a route reading raw request
// fields itself (Task 4 depends on this invariant).
//
// SECURITY GUARD: api-key mode must be completely unaffected — its
// projectId always comes from the authenticated api_keys row, never from
// request-supplied data. Case 4 below is that guard.
//
// Mirrors the fake-req/res + real-Express-on-127.0.0.1 idiom established in
// tests/server/local-dev-team-scope.test.ts (loopback checks pass; no
// Postgres needed for these unit-level cases).
import { createHash } from 'crypto';
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { requirePostgresServerAuth } from '../../../src/server/middleware/postgres-auth.js';

describe('requirePostgresServerAuth — local-dev bypass adopts request projectId', () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) { await closeServer(); closeServer = null; }
  });

  function buildLocalDevApp(localDevProjectId: string | null | undefined) {
    const app = express();
    app.use(express.json());
    const fakePool = {} as Parameters<typeof requirePostgresServerAuth>[0];
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevProjectId,
      requiredScopes: ['memories:read'],
    });
    app.post('/probe', mw, (req, res) => {
      res.json({ projectId: req.authContext?.projectId ?? null, mode: req.authContext?.mode ?? null });
    });
    app.get('/probe', mw, (req, res) => {
      res.json({ projectId: req.authContext?.projectId ?? null, mode: req.authContext?.mode ?? null });
    });
    return app;
  }

  async function startApp(app: ReturnType<typeof express>): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
        closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
        resolve((addr as { port: number }).port);
      });
    });
  }

  it('case 1: req.body.projectId wins over localDevProjectId', async () => {
    const app = buildLocalDevApp('fallback-project');
    const p = await startApp(app);
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p-req' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string | null; mode: string | null };
    expect(body.projectId).toBe('p-req');
    expect(body.mode).toBe('local-dev');
  });

  it('case 2: falls back to localDevProjectId when no request projectId is present', async () => {
    const app = buildLocalDevApp('fallback-project');
    const p = await startApp(app);
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string | null; mode: string | null };
    expect(body.projectId).toBe('fallback-project');
    expect(body.mode).toBe('local-dev');
  });

  it('case 3: req.query.projectId works when there is no body projectId', async () => {
    const app = buildLocalDevApp('fallback-project');
    const p = await startApp(app);
    const res = await fetch(`http://127.0.0.1:${p}/probe?projectId=p-q`, {
      headers: { Host: 'localhost' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string | null; mode: string | null };
    expect(body.projectId).toBe('p-q');
    expect(body.mode).toBe('local-dev');
  });

  it('case 4 (security guard): api-key mode ignores request-supplied projectId — resolves the KEY\'s project', async () => {
    // Fake pool: verifyPostgresApiKey() runs a real SQL SELECT against
    // `pool.query`, so we fake the row it returns instead of touching Postgres.
    // The api-key branch must resolve projectId from that row, never from
    // req.body, even when an attacker supplies a body.projectId that names a
    // different project.
    const rawKey = 'any-key-value';
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const fakePool = {
      query: async (sql: string, params: unknown[]) => {
        expect(params[0]).toBe(keyHash);
        return {
          rows: [{
            id: 'key-1',
            team_id: 'team-1',
            project_id: 'keys-own-project',
            user_id: null,
            scopes: ['memories:read'],
            revoked_at: null,
            expires_at: null,
          }],
        };
      },
    } as unknown as Parameters<typeof requirePostgresServerAuth>[0];
    const app = express();
    app.use(express.json());
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'api-key',
      allowLocalDevBypass: true,
      requiredScopes: ['memories:read'],
    });
    app.post('/probe', mw, (req, res) => {
      res.json({ projectId: req.authContext?.projectId ?? null, mode: req.authContext?.mode ?? null });
    });
    const p = await startApp(app);
    const res = await fetch(`http://127.0.0.1:${p}/probe`, {
      method: 'POST',
      headers: {
        Host: 'localhost',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({ projectId: 'attacker' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string | null; mode: string | null };
    expect(body.projectId).toBe('keys-own-project');
    expect(body.projectId).not.toBe('attacker');
    expect(body.mode).toBe('api-key');
  });
});
