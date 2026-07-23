// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  convert: (input: { databaseUrl: string; ownerUserId: string; cwd: string; teamId: string; serverUrl: string; apiKey: string; projectId: string }) => Promise<ConvertResult>;
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
    const cwd = String(req.body?.cwd ?? '');
    const serverUrl = String(req.body?.serverUrl ?? '');
    const apiKey = String(req.body?.apiKey ?? '');
    const projectId = String(req.body?.projectId ?? '');
    const ownerUserId = req.authContext?.userId;
    const teamId = req.authContext?.teamId ?? '';
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    if (!cwd) { res.status(400).json({ error: 'cwd required' }); return; }
    if (!serverUrl) { res.status(400).json({ error: 'serverUrl required' }); return; }
    if (!apiKey) { res.status(400).json({ error: 'apiKey required' }); return; }
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
    if (!ownerUserId) { res.status(403).json({ error: 'no owner identity' }); return; }
    if (!teamId) { res.status(403).json({ error: 'no team identity' }); return; }
    try {
      res.json(await deps.convert({ databaseUrl: url, ownerUserId, cwd, teamId, serverUrl, apiKey, projectId }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'convert failed' });
    }
  });
}
