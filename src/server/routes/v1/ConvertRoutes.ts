// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';
import type { JoinResult } from '../../convert/join-service.js';

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  applyFix: (databaseUrl: string, fix: string) => Promise<{ ok: boolean; error?: string }>;
  convert: (input: {
    databaseUrl: string;
    ownerUserId: string;
    teamId: string;
    projectId: string;
  }) => Promise<ConvertResult>;
  /**
   * Join an EXISTING team workspace — the other half of Go Team.
   *
   * Separate middleware from convert: joining must NOT require owner, or only
   * the person who already owns the workspace could join it, which is nobody.
   */
  joinAuthMiddleware?: RequestHandler[];
  join?: (input: {
    databaseUrl: string;
    apiKey: string;
    projectId: string;
    projectName?: string;
  }) => Promise<JoinResult>;
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

    // WHICH project gets copied comes from authContext and nothing else.
    //
    // This previously resolved the project by reading a marker file from the
    // SERVER's cwd. One server serves every local project, so that was always
    // whichever project the server was launched from — and a request to convert
    // project A copied project B's entire memory to the remote instead. Reading
    // a request body field would be equally wrong: it would let any owner
    // exfiltrate another project by asking. authContext.projectId derives from
    // the api_keys row, so the caller cannot steer it.
    //
    // No fallback on purpose: falling back to disk is exactly what caused the
    // leak, so an unresolvable project fails loudly instead of guessing.
    const projectId = req.authContext?.projectId;
    const teamId = req.authContext?.teamId;
    if (!projectId || !teamId) {
      res.status(400).json({
        error: 'no project scope on this credential — cannot determine which project to convert',
      });
      return;
    }

    try {
      res.json(await deps.convert({ databaseUrl: url, ownerUserId, teamId, projectId }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'convert failed' });
    }
  });

  // POST /v1/join — attach THIS project to a team workspace that already exists.
  //
  // The counterpart to convert, and previously missing entirely: the wizard told
  // teammates to run `memsmith join --key … --url …`, a command that does not
  // exist in the CLI. Every join was a dead end.
  //
  // NOT owner-gated. Convert requires owner because it moves the owner's data;
  // join is what a NON-owner does, so requiring owner would mean only the person
  // who already has the workspace could join it.
  //
  // Possession of the team key IS the authorization — join-service verifies it
  // against the remote's api_keys and rejects unknown, revoked, expired, and
  // teamless keys. The project comes from authContext, never the body, for the
  // same reason convert does: the caller must not be able to name someone else's
  // project.
  if (deps.join) {
    app.post('/v1/join', ...(deps.joinAuthMiddleware ?? deps.authMiddleware), async (req: any, res: any) => {
      const databaseUrl = String(req.body?.databaseUrl ?? '');
      const apiKey = String(req.body?.apiKey ?? '');
      const projectId = req.authContext?.projectId;
      if (!projectId) {
        res.status(400).json({ error: 'no project scope on this credential — cannot determine which project to join' });
        return;
      }
      try {
        const result = await deps.join!({
          databaseUrl,
          apiKey,
          projectId,
          projectName: typeof req.body?.projectName === 'string' ? req.body.projectName : undefined,
        });
        // 422 on a rejected invite, not 500: a wrong key is a user-correctable
        // input, not a server fault, and the UI shows the reason inline.
        res.status(result.status === 'joined' ? 200 : 422).json(result);
      } catch (err: any) {
        res.status(500).json({ status: 'failed', error: err?.message ?? 'join failed' });
      }
    });
  }
}
