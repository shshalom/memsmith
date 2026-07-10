// SPDX-License-Identifier: Apache-2.0
//
// Tests for MEMSMITH_LOCAL_DEV_PROJECT_ID wiring: the local-dev loopback bypass
// must set authContext.projectId from the configured project ID (parallel to
// localDevTeamId) so /v1/search, /v1/context and /dashboard/* are usable
// keylessly without passing an explicit projectId. Same safety rule: only
// inside the loopback + local-dev bypass, never in api-key mode.
//
// Pure: exercises the middleware via a real loopback HTTP request; the bypass
// branch never touches Postgres.
import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { requirePostgresServerAuth } from '../../src/server/middleware/postgres-auth.js';

describe('requirePostgresServerAuth — localDevProjectId wiring', () => {
  let closeServer: (() => Promise<void>) | undefined;

  async function startApp(opts: { localDevTeamId?: string | null; localDevProjectId?: string | null }): Promise<number> {
    const app = express();
    const fakePool = {} as Parameters<typeof requirePostgresServerAuth>[0];
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'local-dev',
      allowLocalDevBypass: true,
      localDevTeamId: opts.localDevTeamId,
      localDevProjectId: opts.localDevProjectId,
      requiredScopes: ['memories:read'],
    });
    app.get('/probe', mw, (req, res) => {
      res.json({
        teamId: req.authContext?.teamId ?? null,
        projectId: req.authContext?.projectId ?? null,
        mode: req.authContext?.mode ?? null,
      });
    });
    return new Promise((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
        closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
        resolve(addr.port);
      });
    });
  }

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = undefined;
  });

  it('sets authContext.projectId from localDevProjectId on a keyless loopback request', async () => {
    const p = await startApp({ localDevTeamId: 'TID', localDevProjectId: 'PID' });
    const res = await fetch(`http://127.0.0.1:${p}/probe`, { headers: { Host: 'localhost' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { teamId: string | null; projectId: string | null; mode: string | null };
    expect(body.teamId).toBe('TID');
    expect(body.projectId).toBe('PID');
    expect(body.mode).toBe('local-dev');
  });

  it('leaves projectId null when localDevProjectId is not provided (existing behavior)', async () => {
    const p = await startApp({ localDevTeamId: 'TID', localDevProjectId: null });
    const res = await fetch(`http://127.0.0.1:${p}/probe`, { headers: { Host: 'localhost' } });
    expect(res.status).toBe(200);
    const body = await res.json() as { projectId: string | null };
    expect(body.projectId).toBeNull();
  });

  it('does NOT apply localDevProjectId in api-key mode (safety: keyless request returns 401)', async () => {
    const app = express();
    const fakePool = {} as Parameters<typeof requirePostgresServerAuth>[0];
    const mw = requirePostgresServerAuth(fakePool, {
      authMode: 'api-key',
      allowLocalDevBypass: false,
      localDevTeamId: 'TID',
      localDevProjectId: 'PID',
      requiredScopes: ['memories:read'],
    });
    app.get('/probe', mw, (_req, res) => { res.json({ ok: true }); });
    const p = await new Promise<number>((resolve, reject) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') { reject(new Error('no port')); return; }
        closeServer = () => new Promise<void>((res, rej) => srv.close(err => err ? rej(err) : res()));
        resolve((addr as { port: number }).port);
      });
    });
    const res = await fetch(`http://127.0.0.1:${p}/probe`, { headers: { Host: 'localhost' } });
    expect(res.status).toBe(401);
  });
});
