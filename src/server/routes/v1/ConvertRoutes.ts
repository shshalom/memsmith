// SPDX-License-Identifier: Apache-2.0
import type { RequestHandler } from 'express';
import type { ProbeResult } from '../../convert/connection-probe.js';
import type { ConvertResult } from '../../convert/convert-service.js';
import type { JoinResult } from '../../convert/join-service.js';

export type ConvertTransport =
  | { kind: 'https'; serverUrl: string; teamKey: string }
  | { kind: 'postgres'; databaseUrl: string }
  | { kind: 'error'; message: string };

/**
 * Decide which transport a convert request is asking for, from the shape of its input.
 *
 * A `postgres://` value in the serverUrl field is an ERROR, not a fallback. The HTTPS
 * path exists because the machine running convert cannot open a Postgres socket to a
 * managed database — measured: a direct probe of the real RDS returns
 * "Connection terminated due to connection timeout" even on VPN. Silently taking the
 * direct path would turn a nameable mistake into a hang.
 *
 * When both are supplied, HTTPS wins: it is the path that works for a managed database,
 * and the direct path remains available by omitting the server URL.
 */
export function selectConvertTransport(input: {
  serverUrl?: unknown;
  teamKey?: unknown;
  databaseUrl?: unknown;
}): ConvertTransport {
  const serverUrl = typeof input.serverUrl === 'string' ? input.serverUrl.trim() : '';
  const teamKey = typeof input.teamKey === 'string' ? input.teamKey.trim() : '';
  const databaseUrl = typeof input.databaseUrl === 'string' ? input.databaseUrl.trim() : '';

  if (serverUrl) {
    if (/^postgres(ql)?:\/\//i.test(serverUrl)) {
      return {
        kind: 'error',
        message: 'serverUrl must be an https:// endpoint, not a postgres:// connection string',
      };
    }
    if (!/^https?:\/\//i.test(serverUrl)) {
      return { kind: 'error', message: 'serverUrl must start with https://' };
    }
    if (!teamKey) {
      return { kind: 'error', message: 'a team key is required with a server URL' };
    }
    return { kind: 'https', serverUrl, teamKey };
  }
  if (databaseUrl) return { kind: 'postgres', databaseUrl };
  return {
    kind: 'error',
    message: 'provide either a server URL and team key, or a database URL',
  };
}

export interface ConvertRoutesDeps {
  authMiddleware: RequestHandler[]; // [writeAuth..., requireRole('owner')]
  probe: (databaseUrl: string) => Promise<ProbeResult>;
  /**
   * Probe an HTTPS destination: is the team server reachable, and does this key
   * authenticate against it? Optional so an older caller that only wires `probe`
   * keeps working — the route reports that clearly rather than crashing.
   */
  probeHttps?: (serverUrl: string, teamKey: string) => Promise<unknown>;
  applyFix: (databaseUrl: string, fix: string) => Promise<{ ok: boolean; error?: string }>;
  convert: (input: {
    /** Empty on the HTTPS path — read `transport` instead. */
    databaseUrl: string;
    /**
     * Which transport to move the data over. The HTTPS destination has no database URL,
     * so the implementation selects CopyDeps from this rather than from databaseUrl.
     */
    transport?: ConvertTransport;
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
    const transport = selectConvertTransport(req.body ?? {});
    if (transport.kind === 'error') {
      res.status(400).json({ error: transport.message });
      return;
    }
    try {
      if (transport.kind === 'https') {
        // An HTTPS destination is probed by asking the SERVER about itself. The owner
        // never touches the destination database on this path, so pgvector/schema
        // fitness are the team server's own guarantees — it reports them from
        // /v1/info — rather than something to verify by connecting.
        if (!deps.probeHttps) {
          res.status(400).json({ error: 'this server cannot probe an https destination' });
          return;
        }
        res.json(await deps.probeHttps(transport.serverUrl, transport.teamKey));
        return;
      }
      res.json(await deps.probe(transport.databaseUrl));
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
    // Same selector as test-connection, so the destination that was probed is the
    // destination that gets converted. Diverging here is how a green probe could be
    // followed by a convert against something else entirely.
    const transport = selectConvertTransport(req.body ?? {});
    if (transport.kind === 'error') { res.status(400).json({ error: transport.message }); return; }
    const ownerUserId = req.authContext?.userId;
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
      // The transport is passed through rather than flattened to a databaseUrl: the
      // HTTPS destination has no database URL at all, and inventing one would be the
      // silent fallback this design exists to prevent.
      res.json(await deps.convert({
        databaseUrl: transport.kind === 'postgres' ? transport.databaseUrl : '',
        transport,
        ownerUserId,
        teamId,
        projectId,
      }));
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
