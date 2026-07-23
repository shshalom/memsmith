// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';
import type { ResolveConvertContext } from '../../convert/convert-context.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  convert: (input: { databaseUrl: string; ownerUserId: string; cwd: string; teamId: string; serverUrl: string; apiKey: string; projectId: string }) => Promise<ConvertResult>;
  resolveConvertContext: ResolveConvertContext;
}

export function registerConvertRoutes(app: import('express').Application, deps: ConvertRoutesDeps): void {
  app.post('/v1/convert/test-connection', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    try {
      res.json(await deps.probe(url));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'probe failed' });
    }
  });

  app.post('/v1/convert/migrate', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    const ownerUserId = req.authContext?.userId;
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    if (!ownerUserId) { res.status(403).json({ error: 'no owner identity' }); return; }
    try {
      const ctx = await deps.resolveConvertContext(url);
      if ('error' in ctx) { res.status(400).json({ error: ctx.error }); return; }
      res.json(await deps.convert({
        databaseUrl: url,
        ownerUserId,
        cwd: ctx.cwd,
        teamId: ctx.teamId,
        serverUrl: ctx.serverUrl,
        apiKey: ctx.apiKey,
        projectId: ctx.projectId,
      }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'convert failed' });
    }
  });
}
