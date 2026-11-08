import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { convertRefusalForMarkerDir } from '../../../src/server/convert/marker-scope-guard.js';
import { registerConvertRoutes } from '../../../src/server/routes/v1/ConvertRoutes.js';

// A marker above several repositories (reached through a search root) belongs
// to all of them. Converting it flipped every one of those repositories to the
// team at once, and the marker it shared lived in no repository at all.

function marker(dir: string, projectId: string) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: 't', projectId, note: 'n' }));
}

let ws: string;
const env = () => ({ home: join(ws, 'not-home'), searchRoots: [ws] });

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'ms-guard-')));
  mkdirSync(join(ws, 'api', '.git'), { recursive: true });
  marker(ws, 'p-ws');
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('convert of a marker above the git root', () => {
  it('is refused while a repository below resolves to it', () => {
    const refusal = convertRefusalForMarkerDir(ws, env());
    expect(refusal).toContain(join(ws, 'api'));
    expect(refusal).toContain('memsmith link --new');
  });

  it('is allowed once every repository below has its own project', () => {
    marker(join(ws, 'api'), 'p-api');
    expect(convertRefusalForMarkerDir(ws, env())).toBeNull();
  });

  it('is allowed when no search root makes the repositories use it', () => {
    expect(convertRefusalForMarkerDir(ws, { home: join(ws, 'not-home'), searchRoots: [] })).toBeNull();
  });

  it('is allowed for a marker at a git root', () => {
    expect(convertRefusalForMarkerDir(join(ws, 'api'), env())).toBeNull();
  });

  it('stops the convert route before anything is copied', async () => {
    const converted: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.authContext = { userId: 'u', projectId: 'p-ws', teamId: 't', role: 'owner' }; next(); });
    registerConvertRoutes(app, {
      authMiddleware: [],
      probe: async () => ({ allGreen: true } as never),
      applyFix: async () => ({ ok: true }),
      convert: async (input: { projectId: string }) => { converted.push(input.projectId); return { status: 'converted' } as never; },
      convertRefusal: async () => convertRefusalForMarkerDir(ws, env()),
    } as never);
    const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/v1/convert/migrate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ databaseUrl: 'postgres://x/y' }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('memsmith link --new');
      expect(converted).toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
