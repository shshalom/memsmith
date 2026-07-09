// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Pool } from 'pg';
import express from 'express';
import type { AddressInfo } from 'net';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { SettingsStore } from '../../src/server/settings/SettingsStore.js';
import { SettingsResolver } from '../../src/server/settings/SettingsResolver.js';
import { registerSettingsRoutes, type SettingsRouteDeps } from '../../src/server/routes/v1/settingsRoutes.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-v1-settings';

// Minimal app that injects an authContext + admin scope, then mounts the routes.
function appWith(scope: string[], extraDeps?: Partial<SettingsRouteDeps>) {
  const store = new SettingsStore(pool);
  const resolver = new SettingsResolver(store, { ttlMs: 0 });
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authContext = { teamId: TEAM, scopes: scope }; next(); });
  registerSettingsRoutes(app, {
    resolver,
    store,
    requireScopes: (req: any, res: any, needed: string) => {
      if (req.authContext.scopes.includes('*') || req.authContext.scopes.includes(needed)) return true;
      res.status(403).json({ error: 'Forbidden' }); return false;
    },
    ...extraDeps,
  });
  return app;
}

// Start an express app on an ephemeral port and return a helper that makes HTTP calls.
async function startApp(scope: string[]): Promise<{ call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>; close: () => Promise<void> }> {
  const app = appWith(scope);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const call = async (method: string, path: string, body?: unknown) => {
        const init: RequestInit = {
          method: method.toUpperCase(),
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined,
        };
        const res = await fetch(`${base}${path}`, init);
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

describe('/v1/settings', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await pool.query('DELETE FROM server_settings WHERE team_id = $1', [TEAM]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('GET returns all knobs with provenance and metadata', async () => {
    const { call, close } = await startApp(['memories:read']);
    try {
      const res = await call('GET', '/v1/settings');
      expect(res.status).toBe(200);
      expect(res.body.settings.provider.type).toBe('enum');
      expect(res.body.settings.provider.source).toBe('default');
      expect(res.body.settings.monthlyTokenCap.boot).toBe(true);
    } finally {
      await close();
    }
  });

  it('PATCH without settings:admin is 403', async () => {
    const { call, close } = await startApp(['memories:read']);
    try {
      const res = await call('PATCH', '/v1/settings', { patch: { tiering: false } });
      expect(res.status).toBe(403);
    } finally {
      await close();
    }
  });

  it('PATCH validates and persists a live knob', async () => {
    const { call, close } = await startApp(['settings:admin']);
    try {
      const res = await call('PATCH', '/v1/settings', { patch: { tiering: false } });
      expect(res.status).toBe(200);
      expect(res.body.settings.tiering.value).toBe(false);
      expect(res.body.settings.tiering.source).toBe('team');
    } finally {
      await close();
    }
  });

  it('PATCH rejects out-of-range with 400 and no write', async () => {
    const { call, close } = await startApp(['settings:admin']);
    try {
      const res = await call('PATCH', '/v1/settings', { patch: { ftsWeight: 5 } });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('PATCH to cloud provider without key is 400 MissingProviderKey', async () => {
    const { call, close } = await startApp(['settings:admin']);
    try {
      delete process.env.MEMSMITH_ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const res = await call('PATCH', '/v1/settings', { patch: { provider: 'claude' } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MissingProviderKey');
    } finally {
      await close();
    }
  });

  it('PATCH ollama->claude with key but no confirm returns confirmationRequired', async () => {
    // ensure provider is reset to default (ollama) first
    await pool.query('DELETE FROM server_settings WHERE team_id = $1', [TEAM]);

    process.env.MEMSMITH_ANTHROPIC_API_KEY = 'sk-test';
    const { call, close } = await startApp(['settings:admin']);
    try {
      // ensure current provider resolves to a local one (default ollama)
      const res = await call('PATCH', '/v1/settings', { patch: { provider: 'claude' } });
      expect(res.status).toBe(200);
      expect(res.body.confirmationRequired).toBe(true);
      // confirm applies it
      const res2 = await call('PATCH', '/v1/settings', { patch: { provider: 'claude' }, confirm: true });
      expect(res2.body.settings.provider.value).toBe('claude');
    } finally {
      delete process.env.MEMSMITH_ANTHROPIC_API_KEY;
      await close();
    }
  });

  it('calls auditFn exactly once on successful PATCH', async () => {
    const calls: { action: string; keys: string[] }[] = [];
    const auditFn = async (_req: any, action: string, _targetId: string | null, _projectId: string | null, details?: Record<string, unknown>) => {
      calls.push({ action, keys: (details?.keys as string[]) ?? [] });
    };

    const app = appWith(['settings:admin'], { auditFn });
    const server = await new Promise<{ call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>; close: () => Promise<void> }>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;
        const call = async (method: string, path: string, body?: unknown) => {
          const init: RequestInit = { method: method.toUpperCase(), headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined };
          const res = await fetch(`${base}${path}`, init);
          let json: any; try { json = await res.json(); } catch { json = null; }
          return { status: res.status, body: json };
        };
        const close = () => new Promise<void>((res, rej) => s.close((err) => err ? rej(err) : res()));
        resolve({ call, close });
      });
      s.on('error', reject);
    });

    try {
      const res = await server.call('PATCH', '/v1/settings', { patch: { tiering: false } });
      expect(res.status).toBe(200);
      expect(calls.length).toBe(1);
      expect(calls[0]!.action).toBe('settings.update');
      expect(calls[0]!.keys).toContain('tiering');
    } finally {
      await server.close();
    }
  });

  it('does NOT call auditFn on validation failure', async () => {
    const calls: unknown[] = [];
    const auditFn = async () => { calls.push(true); };

    const app = appWith(['settings:admin'], { auditFn });
    const server = await new Promise<{ call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>; close: () => Promise<void> }>((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;
        const call = async (method: string, path: string, body?: unknown) => {
          const init: RequestInit = { method: method.toUpperCase(), headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined };
          const res = await fetch(`${base}${path}`, init);
          let json: any; try { json = await res.json(); } catch { json = null; }
          return { status: res.status, body: json };
        };
        const close = () => new Promise<void>((res, rej) => s.close((err) => err ? rej(err) : res()));
        resolve({ call, close });
      });
      s.on('error', reject);
    });

    try {
      const res = await server.call('PATCH', '/v1/settings', { patch: { ftsWeight: 999 } });
      expect(res.status).toBe(400);
      expect(calls.length).toBe(0);
    } finally {
      await server.close();
    }
  });
});
