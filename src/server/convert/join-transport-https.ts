// SPDX-License-Identifier: Apache-2.0
//
// The HTTPS join transport — the outward hop that replaces opening a Postgres
// pool to the team database from the joiner's machine.
//
// With this, a teammate's machine holds the team KEY and nothing else: no
// database URL, no password, at any point in the project's lifecycle. (The
// steady state after joining was already HTTPS-only — flip-to-team.ts writes
// { runtime: 'server', serverUrl } and never persists a databaseUrl, and
// server-client.ts talks to serverBaseUrl with a Bearer token. The join
// handshake was the last place a database credential was needed.)
//
// The key is sent in the BODY, deliberately, not as `Authorization: Bearer`.
// As a header it would be evaluated by the auth middleware, which returns null
// for missing/revoked/expired/insufficient-scope alike → one flat 401. That
// would destroy the four distinct reasons this design exists to preserve.

import type { JoinRegisterResult, JoinTransport } from './join-transport.js';

/** True when the invite URL names an HTTP(S) endpoint rather than a database. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function makeHttpsJoinTransport(fetchImpl: typeof fetch = fetch): JoinTransport {
  return {
    register: async ({ serverUrl, teamKey, projectId, projectName }): Promise<JoinRegisterResult> => {
      const url = `${stripTrailingSlash(serverUrl)}/v1/join/register`;
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teamKey,
            projectId,
            // Omit rather than send undefined, so the wire body matches the
            // route's optional-field contract exactly.
            ...(projectName ? { projectName } : {}),
          }),
        });
      } catch {
        // Distinguish "cannot reach it" from "reached it and was rejected": the
        // two have completely different fixes. Deliberately does NOT include the
        // thrown message — a fetch error can echo the request, and the request
        // contains the team key.
        return { status: 'failed', error: `cannot reach that server at ${stripTrailingSlash(serverUrl)}` };
      }

      let body: any = null;
      try { body = await response.json(); } catch { body = null; }

      if (response.status === 429) {
        return {
          status: 'failed',
          error: 'too many attempts — wait a few minutes and try again',
        };
      }

      if (response.status === 200) {
        const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : '';
        // A 200 with no teamId cannot be acted on: the caller needs it to
        // repoint the local key and marker. Treat it as a failure rather than
        // flipping into team mode naming nothing.
        if (!teamId) {
          return { status: 'failed', error: 'the server accepted the join but returned no team' };
        }
        return { status: 'joined', teamId };
      }

      // 422 carries the actionable reason; pass it through verbatim rather than
      // generalising it, because that reason is the point of the design.
      const reason = typeof body?.error === 'string' && body.error.trim()
        ? body.error
        : `the server rejected the join (HTTP ${response.status})`;
      return { status: 'failed', error: reason };
    },
  };
}
