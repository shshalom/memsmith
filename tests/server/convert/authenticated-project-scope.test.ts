// SPDX-License-Identifier: Apache-2.0
//
// THE LEAK THIS PINS SHUT (found live 2026-07-28, P3 testing):
//
// POST /v1/convert/migrate resolved WHICH project to convert by reading a file
// off the server's own disk:
//
//   const convertCwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
//   ... makeResolveConvertContext({ cwd: convertCwd, readScope: ... })
//
// One server serves every local project, and its cwd is whichever project it was
// launched from — the dogfood. So a request asking to convert the temp project
// read the DOGFOOD's marker, resolved the DOGFOOD's projectId, and copied ~29,000
// dogfood rows (4,415 observations) to the remote instead of the temp project's
// ~157. Verified by row-count fingerprint: the destination's counts matched the
// dogfood exactly, not the requested project.
//
// It only stopped because observations_created_by_job_id_fkey aborted the copy
// partway. Without that constraint it would have completed and pointed the
// requested project's runtime at a database full of someone else's memory. On a
// real team Postgres that is publishing a user's entire private memory.
//
// THE RULE: the project being converted comes from req.authContext — which is
// derived from the api_keys row and cannot be forged by the request — and NEVER
// from the server's cwd, a marker on disk, or a request body field.
//
// This mirrors the invariant already documented on GET /v1/identity: "the Go Team
// wizard converts req.authContext.projectId — so Settings must display the SAME
// project or a user could convert one project while believing they converted
// another." The convert route one file over did not honour it.
import { describe, it, expect } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import { registerConvertRoutes } from '../../../src/server/routes/v1/ConvertRoutes.js';

const DOGFOOD_PROJECT = '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const DOGFOOD_TEAM = 'ab8e1f17-020e-4794-bae3-e59885e7df05';
const TEMP_PROJECT = '42d7997d-5708-4e26-9e7c-b6f2247085a8';
const TEMP_TEAM = 'bfc62ef3-81f5-4b9e-a904-9456013605f9';

interface Harness {
  call: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
  converted: Array<{ projectId: string; teamId: string }>;
}

// Builds the route with an injected authContext, exactly as the real auth
// middleware would populate it, and records what `convert` was actually asked to
// copy.
async function harness(authContext: Record<string, unknown> | null): Promise<Harness> {
  const converted: Array<{ projectId: string; teamId: string }> = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (authContext) req.authContext = authContext;
    next();
  });

  registerConvertRoutes(app, {
    authMiddleware: [],
    probe: async () => ({ allGreen: true } as any),
    applyFix: async () => ({ ok: true }),
    convert: async (input: { projectId: string; teamId: string }) => {
      converted.push({ projectId: input.projectId, teamId: input.teamId });
      return { status: 'converted', copiedByTable: {}, restartRequired: false };
    },
  } as any);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        converted,
        call: async (path, body) => {
          const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          let json: any = null;
          try { json = await res.json(); } catch { /* empty body */ }
          return { status: res.status, body: json };
        },
        close: () => new Promise<void>((r, j) => server.close(e => e ? j(e) : r())),
      });
    });
    server.on('error', reject);
  });
}

describe('convert copies the AUTHENTICATED project, never the server\'s own', () => {
  it('converts the project from authContext', async () => {
    const h = await harness({
      userId: 'local-owner', projectId: TEMP_PROJECT, teamId: TEMP_TEAM, role: 'owner',
    });
    try {
      const res = await h.call('/v1/convert/migrate', { databaseUrl: 'postgres://x/y' });
      expect(res.status).toBe(200);
      expect(h.converted).toHaveLength(1);
      expect(h.converted[0]!.projectId).toBe(TEMP_PROJECT);
      expect(h.converted[0]!.teamId).toBe(TEMP_TEAM);
    } finally {
      await h.close();
    }
  });

  it('REGRESSION: never converts the server\'s own project when a different one is authenticated', async () => {
    // The exact shape of the leak. The server's cwd marker is the dogfood; the
    // authenticated caller is the temp project. Only the temp project may be read.
    const h = await harness({
      userId: 'local-owner', projectId: TEMP_PROJECT, teamId: TEMP_TEAM, role: 'owner',
    });
    try {
      await h.call('/v1/convert/migrate', { databaseUrl: 'postgres://x/y' });
      expect(h.converted[0]!.projectId).not.toBe(DOGFOOD_PROJECT);
      expect(h.converted[0]!.teamId).not.toBe(DOGFOOD_TEAM);
    } finally {
      await h.close();
    }
  });

  it('ignores a projectId in the request body — the key decides, not the caller', async () => {
    // Defence in depth: even if a body field is supplied, it must not steer the
    // copy. Otherwise any owner could exfiltrate another project by asking.
    const h = await harness({
      userId: 'local-owner', projectId: TEMP_PROJECT, teamId: TEMP_TEAM, role: 'owner',
    });
    try {
      await h.call('/v1/convert/migrate', {
        databaseUrl: 'postgres://x/y',
        projectId: DOGFOOD_PROJECT,
        teamId: DOGFOOD_TEAM,
      });
      expect(h.converted[0]!.projectId).toBe(TEMP_PROJECT);
      expect(h.converted[0]!.teamId).toBe(TEMP_TEAM);
    } finally {
      await h.close();
    }
  });

  it('refuses when authContext carries no project rather than falling back to disk', async () => {
    // Falling back to the server's cwd is precisely what caused the leak, so an
    // unresolvable project must fail loudly instead of guessing.
    const h = await harness({ userId: 'local-owner', role: 'owner' });
    try {
      const res = await h.call('/v1/convert/migrate', { databaseUrl: 'postgres://x/y' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(h.converted).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('refuses when there is no authContext at all', async () => {
    const h = await harness(null);
    try {
      const res = await h.call('/v1/convert/migrate', { databaseUrl: 'postgres://x/y' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(h.converted).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('still requires a databaseUrl', async () => {
    const h = await harness({
      userId: 'local-owner', projectId: TEMP_PROJECT, teamId: TEMP_TEAM, role: 'owner',
    });
    try {
      const res = await h.call('/v1/convert/migrate', {});
      expect(res.status).toBe(400);
      expect(h.converted).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
