// SPDX-License-Identifier: Apache-2.0
//
// May an unauthenticated loopback request READ a tracked project?
//
// THE GAP. A teammate clones a converted project: the committed marker says
// `runtime: 'server'`, so the project belongs to a team, but this machine holds
// no key for that team yet. That is the `tracked` state, and the Join button is
// the affordance for leaving it. The viewer authenticates by API key, so a
// project with no key cannot be displayed at all — and the Join button never
// renders on the one machine that needs it.
//
// TWO REJECTED APPROACHES, both worse:
//
//   A viewer-level special case ("render marker-only projects read-only") makes
//   the dashboard authenticate as one project while displaying another. That is
//   the view/credential disagreement behind all six cookie bugs pinned in
//   tests/server/runtime/viewer-scope-contract.test.ts.
//
//   Deriving the viewed project from the request is the cross-tenant
//   vulnerability resolve-request-database.ts explicitly prohibits: "It must
//   NEVER read req.query.projectId... that would let a caller pick another
//   tenant's database."
//
// THE PATTERN THIS USES is named by that same prohibition: "authContext is
// populated upstream (requirePostgresServerAuth) from a trusted source for every
// auth mode — including the local-dev bypass, which funnels the request-supplied
// project id INTO authContext before this middleware ever runs." The auth layer
// decides what a request may CLAIM; everything downstream reads authContext
// only. So the grant belongs here, and nothing else changes.
//
// WHY THE CONDITIONS ARE ENOUGH. The only projects reachable are ones whose
// marker is already a file on this machine. An attacker able to plant one
// already has local file write, which is strictly more powerful than reading a
// memory row. There is nothing to escalate to: the grant names one project, one
// team, and carries read scope alone.
//
// WHAT IT COSTS, stated plainly: this widens what an unauthenticated loopback
// request can read, and unlike the local-dev bypass — gated behind
// MEMSMITH_ALLOW_LOCAL_DEV_BYPASS, off by default — it is active in api-key
// mode. Any local process could read a tracked project's memories with no
// credential. The same is already true of every project this machine holds a key
// for (that key sits in a 0600 file the same local user can read), so the
// increment is small, but it is real. Single-user-workstation assumptions are
// inherited from the existing local trust model, not fixed here.

/** The marker shape this gate needs. */
export interface TrackedViewMarker {
  teamId: string;
  projectId: string;
  runtime?: string | undefined;
}

export interface TrackedViewInput {
  /** Did the request present any credential (bearer, x-api-key, cookie)? */
  hasKey: boolean;
  isLoopbackIp: boolean;
  isLoopbackHost: boolean;
  hasForwardedHeaders: boolean;
  /** Project named by the request. */
  requestedProjectId?: string | undefined;
  /** Marker found at the path THIS project recorded, or null. */
  marker: TrackedViewMarker | null;
  /** Does CredentialStore hold a key for the marker's team? */
  machineHoldsTeamKey: boolean;
}

export interface TrackedViewGrant {
  teamId: string;
  projectId: string;
  /** Read only. The absent memories:write is what blocks every write route. */
  scopes: readonly string[];
  /** Distinct so this grant is auditable and never mistaken for a credential. */
  mode: 'tracked-local-view';
}

/**
 * Return a read-only grant, or null. Pure — every input is supplied by the
 * caller so all six conditions are testable without an HTTP stack.
 *
 * SCOPES, NOT ROLE, enforce read-only. `baseWrite` is built with
 * `requiredScopes: ['memories:write']`, so omitting that scope fails every write
 * route before a handler runs. The role must NOT be relied on: requireWriteRole
 * computes `allow = role == null || roleSatisfies(role, 'member')`, so a null
 * role is ALLOWED. An earlier draft of this design assumed the opposite and
 * would have shipped a writable "read-only" grant.
 */
export function evaluateTrackedViewGrant(input: TrackedViewInput): TrackedViewGrant | null {
  // A presented credential means normal auth owns this request; this branch must
  // never shadow or weaken it.
  if (input.hasKey) return null;

  // Loopback, three ways. The IP alone is not enough: a loopback socket with a
  // foreign Host header is the DNS-rebinding shape, and a forwarded header means
  // a proxy sits in front so the socket says nothing about the real caller.
  if (!input.isLoopbackIp) return null;
  if (!input.isLoopbackHost) return null;
  if (input.hasForwardedHeaders) return null;

  const requested = input.requestedProjectId?.trim();
  if (!requested) return null;

  // The marker must exist on THIS machine and name THIS project. Without the
  // second half, a marker for project A would unlock a view of project B — the
  // same stale-path leak resolveProjectRuntime guards.
  const marker = input.marker;
  if (!marker || marker.projectId !== requested) return null;

  // Only a TEAM project. A local project has its own key and goes through
  // normal auth; there is no gap to fill. Legacy 'server-beta' still counts.
  const isTeam = marker.runtime === 'server' || marker.runtime === 'server-beta';
  if (!isTeam) return null;

  // Only when no credential could possibly work. If the key exists the project
  // is joined and normal auth applies.
  if (input.machineHoldsTeamKey) return null;

  return {
    teamId: marker.teamId,
    projectId: requested,
    scopes: ['memories:read'],
    mode: 'tracked-local-view',
  };
}
