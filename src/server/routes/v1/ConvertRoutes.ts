// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';
import type { ResolveConvertContext } from '../../convert/convert-context.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  applyFix: (databaseUrl: string, fix: string) => Promise<{ ok: boolean; error?: string }>;
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

  // One-click remediation for a gap the probe marked fixable. Owner-gated like
  // the rest of convert. Without this the wizard deadlocked: Next unlocks only
  // on all-green, and pgvector is missing from essentially every fresh Postgres
  // a team would bring, so no conversion could complete from the UI at all.
  app.post('/v1/convert/apply-fix', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    const fix = String(req.body?.fix ?? '');
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    // Allowlist, not free-form: this endpoint runs DDL, so the caller may only
    // name a remediation MemSmith itself defines.
    if (fix !== 'pgvector') { res.status(400).json({ error: `unknown fix: ${fix || '(none)'}` }); return; }
    try {
      const result = await deps.applyFix(url, fix);
      res.status(result.ok ? 200 : 422).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'fix failed' });
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
