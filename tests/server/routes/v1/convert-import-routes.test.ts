// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/convert/import writes RAW ROWS into seven tables, so its guards are the
// security boundary. Three of these tests exist because of a specific hole found in
// review:
//
//   - requireWriteRole() treats role == null as member-equivalent (postgres-auth.ts:69),
//   - ensureProjectAllowed only rejects when the key HAS a project scope
//     (ServerV1PostgresRoutes.ts:2334),
//   - the team-wide key minted for this deployment has project_id NULL.
//
// Together those would let a roleless team-scoped key write into any project in its
// team. The route therefore refuses a credential with no project scope outright, rather
// than guessing which project was meant.

import { describe, expect, it } from 'bun:test';
import express from 'express';
import { registerConvertImportRoutes } from '../../../../src/server/routes/v1/ConvertImportRoutes.js';

/** Injects an authContext, standing in for the real auth middleware. */
function appWith(authContext: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  const inject: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { authContext: unknown }).authContext = authContext;
    next();
  };
  registerConvertImportRoutes(app, {
    authMiddleware: [inject],
    pool: {
      query: async (text: string) => {
        if (/FROM convert_import_batches/i.test(text)) return { rows: [] };
        if (/information_schema/i.test(text)) return { rows: [] };
        if (/count\(\*\)/i.test(text)) return { rows: [{ count: '2' }] };
        return { rows: [] };
      },
    },
  });
  return app;
}

async function call(
  app: express.Express,
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const OWNER = { projectId: 'p1', teamId: 't1', role: 'owner' };

describe('POST /v1/convert/import', () => {
  it('refuses a credential with no project scope', async () => {
    const res = await call(
      appWith({ projectId: null, teamId: 't1', role: 'owner' }),
      'POST', '/v1/convert/import',
      { table: 'observations', rows: [], batchToken: 'tok' },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a table outside COPY_TABLES', async () => {
    // The table name is interpolated into SQL, so an allowlist — not escaping — is the
    // boundary. It also refuses account tables such as api_keys outright.
    const res = await call(appWith(OWNER), 'POST', '/v1/convert/import',
      { table: 'api_keys', rows: [], batchToken: 'tok' });
    expect(res.status).toBe(400);
  });

  it('requires a batchToken', async () => {
    // Without it a retry cannot be recognised, and per-batch idempotency is the only
    // retry protection most rows have.
    const res = await call(appWith(OWNER), 'POST', '/v1/convert/import',
      { table: 'observations', rows: [] });
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed batch', async () => {
    const res = await call(appWith(OWNER), 'POST', '/v1/convert/import',
      { table: 'observations', rows: [{ id: 'o1', content: 'x' }], batchToken: 'tok' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applied' });
  });

  it('REFUSES a body projectId the credential cannot reach', async () => {
    // This test previously asserted the body projectId was IGNORED — and that encoded a
    // real bug: overwriting it with the key's project silently re-homed an entire
    // convert (source rig-proj-A landed under dest-proj while convert reported success).
    // A migration must PRESERVE the source project, so the id is now honoured — but only
    // after an entitlement check, or it would be a write-anywhere lever.
    const res = await call(appWith(OWNER), 'POST', '/v1/convert/import',
      { table: 'observations', rows: [], batchToken: 'tok2', projectId: 'ATTACKER' });
    expect(res.status).toBe(403);
  });

  it('honours a body projectId that matches the credential', async () => {
    const res = await call(appWith(OWNER), 'POST', '/v1/convert/import',
      { table: 'observations', rows: [], batchToken: 'tok3', projectId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: 'p1' });
  });
});

describe('GET /v1/convert/verify', () => {
  it('returns per-table counts', async () => {
    const res = await call(appWith(OWNER), 'GET', '/v1/convert/verify');
    expect(res.status).toBe(200);
    expect((res.body as { counts: Record<string, number> }).counts.observations).toBe(2);
  });

  it('refuses a credential with no project scope', async () => {
    const res = await call(
      appWith({ projectId: null, teamId: 't1', role: 'owner' }),
      'GET', '/v1/convert/verify',
    );
    expect(res.status).toBe(400);
  });
});
