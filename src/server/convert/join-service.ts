// SPDX-License-Identifier: Apache-2.0
//
// JOINING an existing team workspace — the other half of Go Team.
//
// Convert is for the OWNER: copy this project's local memory up to a shared
// database and flip. Join is for everyone ELSE: point this machine at a team
// that already exists. The joiner has nothing to copy, so join is deliberately
// NOT a variant of convert — no copy, no verify, no attribution re-stamp.
//
// Until now the only documented path was `memsmith join --key <k> --url <u>`,
// a command that DOES NOT EXIST in the CLI (the real command list is adopt,
// cleanup, doctor, install, remove, repair, restart, search, server, start,
// status, stop, telemetry, transcript, uninstall, update, upgrade, version,
// worker). So the wizard's final step instructed teammates to run something
// unimplemented, and every join was a dead end.
//
// It is also the wrong shape even implemented: it asks a person to paste a
// full-access credential and a raw Postgres URL into a terminal. Joining should
// be one action in the dashboard, where you already look to see what mode you
// are in.
//
// WHAT A JOIN MUST ESTABLISH, in this order, because each step gates the next:
//   1. the remote is reachable AND the key authenticates against it
//   2. the key names a team, and that team exists there
//   3. the local project is registered under that team on the remote
//   4. only then: cache the credential and flip the marker
//
// Order matters for the same reason it does in applyConvertJoin: the marker is
// followed by selectRuntime() on the very next hook invocation, so flipping
// before the credential resolves leaves the project in team mode with no key —
// authenticated as nobody, silently dropping every observation.

import { isHttpUrl } from './join-transport-https.js';
import type { JoinRegisterResult } from './join-transport.js';

export interface JoinQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface JoinInput {
  /** The team's Postgres URL, from the invite. */
  databaseUrl: string;
  /** The team's base key, from the invite. */
  apiKey: string;
  /** This machine's project, which is about to become team-scoped. */
  projectId: string;
  /** Human-facing name for the project row on the remote. */
  projectName?: string;
}

export interface JoinResult {
  status: 'joined' | 'failed';
  /** Present on success — what the client needs to apply locally. */
  join?: { teamId: string; projectId: string; serverUrl: string; apiKey: string };
  /** Present on failure — a reason a person can act on. */
  error?: string;
}

export interface JoinDeps {
  /** Open a pool against the remote. Throws if the URL is unusable. */
  connect: (databaseUrl: string) => Promise<JoinQueryable & { end?: () => Promise<void> }>;
  /** Hash a raw key the same way api_keys stores it. */
  hashKey: (raw: string) => string;
  /** Derive the HTTP server URL from the database URL. */
  deriveServerUrl: (databaseUrl: string) => string;
  /** Register this project under the team on the remote. */
  upsertProject: (pool: JoinQueryable, teamId: string, projectId: string, name?: string) => Promise<void>;
  /** Ensure the remote has MemSmith's schema (idempotent). */
  bootstrapSchema?: (pool: JoinQueryable) => Promise<void>;
  /**
   * Reach the remote over HTTPS instead of opening a Postgres pool.
   *
   * When present AND the invite URL is HTTP(S), steps 2-4 (verify the key,
   * verify the team, register the project) all happen server-side, so the
   * joiner never possesses a database credential. Absent — or given a
   * postgres:// URL — the direct-Postgres path below is used unchanged.
   */
  transport?: import('./join-transport.js').JoinTransport;
}

/**
 * Validate an invite and register this machine's project against the team.
 *
 * Returns `failed` with a readable reason rather than throwing: this is driven
 * by a UI form, and a stack trace is not an error message. The caller applies
 * the returned `join` locally (marker + credential) exactly as convert does —
 * the server never writes the joiner's files, because on a real team server
 * those files are on someone else's machine.
 */
export async function runJoin(deps: JoinDeps, input: JoinInput): Promise<JoinResult> {
  const databaseUrl = input.databaseUrl?.trim();
  const apiKey = input.apiKey?.trim();
  if (!databaseUrl) return { status: 'failed', error: 'database URL is required' };
  if (!apiKey) return { status: 'failed', error: 'team key is required' };
  if (!input.projectId?.trim()) return { status: 'failed', error: 'no local project to join with' };

  // HTTPS path: hand the whole remote interaction to the transport. Chosen by
  // the URL scheme, so an existing postgres:// invite keeps working (spec §4.1
  // — the fallback is retained deliberately).
  if (deps.transport && isHttpUrl(databaseUrl)) {
    let result: JoinRegisterResult;
    try {
      result = await deps.transport.register({
        serverUrl: databaseUrl,
        teamKey: apiKey,
        projectId: input.projectId,
        projectName: input.projectName,
      });
    } catch (err) {
      // A transport that throws must read as a failed join, not a 500.
      return { status: 'failed', error: `could not register this project: ${message(err)}` };
    }
    if (result.status !== 'joined') {
      // No `join` payload on failure: applyConvertJoin must have nothing to act
      // on, or the marker could flip into team mode with no resolvable key.
      return { status: 'failed', error: result.error };
    }
    return {
      status: 'joined',
      join: {
        teamId: result.teamId,
        projectId: input.projectId,
        // Already an HTTP(S) base URL — deriveServerUrl exists to turn a
        // DATABASE url into one, so it must not be applied here.
        serverUrl: databaseUrl.replace(/\/+$/, ''),
        apiKey,
      },
    };
  }

  let pool: (JoinQueryable & { end?: () => Promise<void> }) | null = null;
  try {
    try {
      pool = await deps.connect(databaseUrl);
    } catch (err) {
      // Distinguish "cannot reach it" from "reached it and was rejected" — the
      // two have completely different fixes and the user has to know which.
      return { status: 'failed', error: `cannot reach that database: ${message(err)}` };
    }

    // The schema may not exist yet if the owner's convert has not run, and a
    // missing table would otherwise surface as a confusing SQL error.
    if (deps.bootstrapSchema) {
      try { await deps.bootstrapSchema(pool); } catch { /* probed below anyway */ }
    }

    // Does this key exist on that remote, and which team is it for? This is the
    // authentication step: possession of the key IS the proof of membership.
    let teamId: string | null = null;
    try {
      const result = await pool.query(
        'SELECT team_id, revoked_at, expires_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
        [deps.hashKey(apiKey)],
      );
      const row = result.rows[0];
      if (!row) {
        return { status: 'failed', error: 'that key is not valid for this workspace' };
      }
      if (row.revoked_at) return { status: 'failed', error: 'that key has been revoked' };
      const expires = row.expires_at ? new Date(String(row.expires_at)).getTime() : null;
      if (expires !== null && Number.isFinite(expires) && expires <= Date.now()) {
        return { status: 'failed', error: 'that key has expired' };
      }
      teamId = row.team_id ? String(row.team_id) : null;
    } catch (err) {
      return { status: 'failed', error: `could not verify the key: ${message(err)}` };
    }
    if (!teamId) {
      // A key with no team cannot scope anything; joining with it would leave
      // the project authenticated but unroutable.
      return { status: 'failed', error: 'that key is not scoped to a team' };
    }

    // Register this project under the team so the joiner's writes have a home.
    // Idempotent: re-joining, or two teammates joining at once, must both work.
    try {
      await deps.upsertProject(pool, teamId, input.projectId, input.projectName);
    } catch (err) {
      return { status: 'failed', error: `could not register this project: ${message(err)}` };
    }

    return {
      status: 'joined',
      join: {
        teamId,
        projectId: input.projectId,
        serverUrl: deps.deriveServerUrl(databaseUrl),
        apiKey,
      },
    };
  } finally {
    if (pool?.end) { try { await pool.end(); } catch { /* closing is best-effort */ } }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
