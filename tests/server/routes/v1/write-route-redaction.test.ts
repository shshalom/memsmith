// SPDX-License-Identifier: Apache-2.0
//
// Drives the registered /v1/memories and /v1/record-intent handlers against a
// fake pool and asserts that no secret reaches SQL, the embedder, or the
// generation provider. These routes serve every client, including hook
// builds that predate client-side redaction.
import { describe, it, expect, mock, afterAll } from 'bun:test';
import * as embedderModule from '../../../../src/server/generation/embedder.js';

// mock.module is process-wide and survives mock.restore(), so the module that
// was registered before this file is put back in afterAll.
const embedderBefore = { ...embedderModule };
const embeddedTexts: string[] = [];
mock.module('../../../../src/server/generation/embedder.js', () => ({
  embed: async (text: string) => { embeddedTexts.push(text); return Array.from({ length: 384 }, () => 0); },
  embedBatch: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, () => 0)),
}));
afterAll(() => {
  mock.module('../../../../src/server/generation/embedder.js', () => embedderBefore);
});

import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler } from 'express';

const FAKE_KEY = 'sk-ant-api03-' + 'FAKE0test9'.repeat(4);

function makeCapturingPool(sqlParams: unknown[]) {
  const query = async (sql: string, params: unknown[] = []) => {
    sqlParams.push(...params);
    if (sql.includes('FROM projects')) return { rows: [{ id: params[0] }] };
    return { rows: [] };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}

function registeredHandler(routes: ServerV1PostgresRoutes, method: string, path: string): RequestHandler {
  let found: RequestHandler | undefined;
  const app: Record<string, unknown> = { use() {}, set() {} };
  for (const m of ['get', 'post', 'delete', 'patch', 'put']) {
    app[m] = (p: string, ...chain: unknown[]) => {
      if (m === method && p === path) found = chain.flat().at(-1) as RequestHandler;
    };
  }
  routes.setupRoutes(app as never);
  if (!found) throw new Error(`route ${method} ${path} not registered`);
  return found;
}

async function invoke(handler: RequestHandler, body: unknown, pool: unknown) {
  await new Promise<void>((resolve) => {
    const res = {
      status() { return res; },
      json() { resolve(); return res; },
    };
    const req = { body, authContext: { teamId: 't1', projectId: null, userId: null, role: null }, databasePool: pool };
    handler(req as never, res as never, () => resolve());
  });
}

describe('server write routes redact secrets', () => {
  it('POST /v1/memories stores and embeds only redacted content and metadata', async () => {
    const sqlParams: unknown[] = [];
    embeddedTexts.length = 0;
    const pool = makeCapturingPool(sqlParams);
    const routes = new ServerV1PostgresRoutes({ pool: pool as never, queueManager: { getQueue: () => null, resolveQueue: () => null } as never, authMode: 'api-key', allowLocalDevBypass: false });
    await invoke(registeredHandler(routes, 'post', '/v1/memories'), {
      projectId: 'p1',
      kind: 'user_note',
      content: `The deploy key is ${FAKE_KEY}.`,
      metadata: { userDirected: true, facts: [`ANTHROPIC_API_KEY=${FAKE_KEY}`] },
    }, pool);

    const stored = JSON.stringify(sqlParams);
    expect(stored).toContain('The deploy key is [REDACTED:anthropic_key].');
    expect(stored).toContain('ANTHROPIC_API_KEY=[REDACTED:anthropic_key]');
    expect(stored).not.toContain(FAKE_KEY);
    expect(embeddedTexts).toEqual(['The deploy key is [REDACTED:anthropic_key].']);
  });

  it('POST /v1/record-intent sends only a redacted prompt to the provider', async () => {
    const providerBodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
      providerBodies.push(String(init.body ?? ''));
      return new Response(JSON.stringify({ message: { content: 'NONE' } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const pool = makeCapturingPool([]);
      const routes = new ServerV1PostgresRoutes({
        pool: pool as never,
        queueManager: { getQueue: () => null, resolveQueue: () => null } as never,
        authMode: 'api-key',
        allowLocalDevBypass: false,
        generationProviderHolder: { current: async () => ({ providerLabel: 'ollama' }) } as never,
      });
      await invoke(registeredHandler(routes, 'post', '/v1/record-intent'), {
        projectId: 'p1',
        prompt: `remember that the staging key is ${FAKE_KEY}`,
      }, pool);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(providerBodies.length).toBe(1);
    expect(providerBodies[0]).not.toContain(FAKE_KEY);
    expect(providerBodies[0]).toContain('[REDACTED:anthropic_key]');
  });
});
