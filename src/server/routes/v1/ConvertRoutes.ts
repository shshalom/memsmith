// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  convert: (input: { databaseUrl: string; ownerUserId: string }) => Promise<ConvertResult>;
}

export function registerConvertRoutes(app: import('express').Application, deps: ConvertRoutesDeps): void {
  app.post('/v1/convert/test-connection', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    res.json(await deps.probe(url));
  });

  app.post('/v1/convert/migrate', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    const ownerUserId = req.authContext?.userId;
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    if (!ownerUserId) { res.status(403).json({ error: 'no owner identity' }); return; }
    res.json(await deps.convert({ databaseUrl: url, ownerUserId }));
  });
}
