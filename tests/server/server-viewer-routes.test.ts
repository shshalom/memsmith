// SPDX-License-Identifier: Apache-2.0
//
// #2552 — the Viewer UI + API compat layer must be reachable on the server
// runtime. We register ServerViewerRoutes alongside a stub API route on the
// SAME Express app (as ServerService does) and assert:
//   - the viewer root `/` responds (HTML when built, 503 when not),
//   - the static handler does NOT shadow a co-mounted API route.

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { Server, type ServerOptions } from '../../src/services/server/Server.js';
import { ServerViewerRoutes } from '../../src/server/runtime/ServerViewerRoutes.js';

function baseOptions(): ServerOptions {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  };
}

describe('ServerViewerRoutes on the server runtime (#2552)', () => {
  let server: Server | null = null;
  let spies: ReturnType<typeof spyOn>[] = [];

  afterEach(async () => {
    spies.forEach(s => s.mockRestore());
    spies = [];
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  it('serves the viewer root and does not shadow a co-mounted API route', async () => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
    server = new Server(baseOptions());

    // Mirror ServerService: register an API route BEFORE the viewer's
    // static handler so we can prove the static handler does not swallow it.
    server.registerRoutes({
      setupRoutes(app) {
        app.get('/v1/info', (_req, res) => {
          res.json({ name: 'memsmith-server', runtime: 'server-beta' });
        });
      },
    });
    server.registerRoutes(new ServerViewerRoutes());
    server.finalizeRoutes();

    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

    // The co-mounted API route still resolves (compat/v1 layer reachable).
    const apiRes = await fetch(`http://127.0.0.1:${port}/v1/info`);
    expect(apiRes.status).toBe(200);
    const apiBody = await apiRes.json();
    expect(apiBody.runtime).toBe('server-beta');

    // The viewer root route is registered and responds. When the build shipped
    // a viewer.html it is 200 text/html; otherwise it is a clean 503 (not a
    // 404/crash), proving the handler is mounted.
    const rootRes = await fetch(`http://127.0.0.1:${port}/`);
    if (ServerViewerRoutes.hasViewerHtml()) {
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get('content-type')).toContain('text/html');
    } else {
      expect(rootRes.status).toBe(503);
      const body = await rootRes.json();
      expect(body.error).toBe('ViewerUnavailable');
    }
  });

  // The local dashboard could not read its own data: the machine mints a base
  // key but nothing handed it to the browser, so every read 401'd. GET / now
  // issues that key as a loopback cookie. These cases exercise the real HTTP
  // path end-to-end, because the first cut of this fix passed its unit tests
  // while silently issuing no cookie at all (it gated on an env var that lives
  // in settings.json, not process.env).
  async function serveRootWith(resolveLocalKey: (() => string | null) | undefined, headers: Record<string, string> = {}) {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({ resolveLocalKey }));
    server.finalizeRoutes();
    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
    return res.headers.get('set-cookie');
  }

  it('issues the local key as an HttpOnly loopback cookie', async () => {
    const cookie = await serveRootWith(() => 'cmem_localkey000000000000000000000');
    expect(cookie).toContain('memsmith_local_key=cmem_localkey000000000000000000000');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('issues NO cookie when the machine has no local key (team/server mode)', async () => {
    expect(await serveRootWith(() => null)).toBeNull();
  });

  it('issues NO cookie when no resolver is wired at all', async () => {
    expect(await serveRootWith(undefined)).toBeNull();
  });

  it('issues NO cookie to a request that was forwarded from elsewhere', async () => {
    const cookie = await serveRootWith(
      () => 'cmem_localkey000000000000000000000',
      { 'X-Forwarded-For': '203.0.113.9' },
    );
    expect(cookie).toBeNull();
  });

  it('issues NO cookie when the Host header is not loopback', async () => {
    const cookie = await serveRootWith(
      () => 'cmem_localkey000000000000000000000',
      { Host: 'memsmith.example.com' },
    );
    expect(cookie).toBeNull();
  });

  it('still serves the page when resolving the key throws', async () => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];
    server = new Server(baseOptions());
    server.registerRoutes(new ServerViewerRoutes({
      resolveLocalKey: () => { throw new Error('credentials unreadable'); },
    }));
    server.finalizeRoutes();
    const port = 42000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
    // A credential read must never take down the page itself.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
