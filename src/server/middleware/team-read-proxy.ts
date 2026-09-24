// SPDX-License-Identifier: Apache-2.0
//
// Where should a dashboard read for THIS project actually go?
//
// After a join, a project's memory lives on the TEAM server: the marker says
// `runtime: 'server'` and names the serverUrl, and the team key is cached in
// ~/.memsmith. But the dashboard only ever calls 127.0.0.1, and the LOCAL server
// rejects that key — it validates against its own api_keys table, where a
// team-issued credential does not exist.
//
// Verified live: /dashboard/metrics with the team key returned 403 locally and
// 200 against AWS. So a joined project could not be viewed at all. Immediately
// after a join that had genuinely succeeded — marker flipped, key cached, team
// memory readable from the hook path — the dashboard said "Not authenticated"
// and showed nothing.
//
// THE SHAPE: the local server proxies. The browser keeps calling localhost, the
// local server forwards to marker.serverUrl with the cached key, and the team
// credential never enters browser JavaScript. Handing the key to the page would
// put a live team credential in devtools and require CORS on the team server.
//
// This module decides ONLY whether to proxy and where to; the forwarding lives
// with the route. Separating the judgement keeps these rules testable without a
// network, and each refusal below is a case where forwarding would be wrong
// rather than merely unnecessary.

export interface TeamProxyMarker {
  teamId: string;
  projectId: string;
  runtime?: string | undefined;
  serverUrl?: string | undefined;
}

export interface TeamProxyInput {
  /** Marker for the project the request names, or null. */
  marker: TeamProxyMarker | null;
  /** Cached key for the marker's team, or null when not joined. */
  teamKey: string | null;
  /** Request path, e.g. '/dashboard/metrics'. */
  path: string;
  /** Raw query string including '?', or ''. */
  search: string;
}

export interface TeamProxyTarget {
  url: string;
  key: string;
}

/**
 * Resolve the team URL to forward to, or null to serve locally. Never throws.
 *
 * Null is the safe answer everywhere: it means "read locally", which is correct
 * for a local project and honest for a tracked one (capture is deliberately
 * local until the user joins).
 */
export function resolveTeamProxyTarget(input: TeamProxyInput): TeamProxyTarget | null {
  const marker = input.marker;
  if (!marker) return null;

  // Only a team project. A local project's data is local; forwarding it would
  // send a local read to someone else's server.
  const isTeam = marker.runtime === 'server' || marker.runtime === 'server-beta';
  if (!isTeam) return null;

  // No key: the TRACKED state — recognized but not joined. Nothing to forward,
  // and capture is local by design until join, so read locally.
  if (!input.teamKey) return null;

  const base = marker.serverUrl?.trim();
  if (!base) return null;

  // A marker is a file on disk and could name anything. Only http(s) is a team
  // server; refuse file:// and friends rather than hand them to fetch.
  if (!/^https?:\/\//i.test(base)) return null;

  // Strip a trailing slash so the joined path is not doubled.
  const origin = base.replace(/\/+$/, '');
  return { url: `${origin}${input.path}${input.search}`, key: input.teamKey };
}
