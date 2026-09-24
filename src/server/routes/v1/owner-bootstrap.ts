// SPDX-License-Identifier: Apache-2.0
//
// May this caller become the owner of this team?
//
// THE PROBLEM. A user converts a local project to a team server and
// POST /v1/convert/register-key answers 403 "requires role owner". The team key
// they hold authenticates, but its user_id has no team_members row on the
// remote, so getMemberRole returns null (postgres-auth.ts:447) and every
// role-gated route is shut. Minting a role-bearing key needs `admin`; becoming
// `admin` needs a role-bearing key. The only existing escape is
// `server api-key create --user <id> --role owner`, a CLI that connects straight
// to Postgres — impossible against a private RDS without VPN or an in-VPC task.
//
// That contradicts the requirement outright: a user must not need AWS access to
// use their own team. The in-VPC bootstrap task was a workaround, never a fix.
//
// THE RULE, borrowed from what already works locally. ensureProjectIdentity
// writes an owner row for the team it mints (project-identity.ts:212), so the
// user genuinely owns their own project — that assertion simply never crossed
// the wire. This carries it over: a valid team key may establish itself as owner
// ONLY while the team has no owner. Once one exists the route is dead and the
// normal `admin` path governs.
//
// WHAT IT GRANTS, measured rather than assumed. A leaked team key ALREADY reads
// (/v1/search → 200) and writes (/v1/events → 201) the team's memory. What it
// cannot do — and ownership hands over — is mint further keys, manage members
// (including demoting the real owner), and DELETE /v1/projects/:id/memory.
// Minting is persistence that outlives revoking the leaked key; the delete is
// destruction, the one thing this product exists to prevent. So this IS a real
// escalation, created here rather than pre-existing, and both gates below are
// required:
//
//   1. An operator flag, default OFF. A deployment must choose this.
//   2. A time window from team creation. Ownership is a setup-time act; a team
//      that has existed for days with no owner is misconfigured, and an open
//      door there is a standing vulnerability rather than a narrow window.
//
// Either alone leaves a hole: a flag can be left on forever, and a window
// applies to every team on a deployment that never wanted this at all.

/** Default window: ownership is a setup-time act, measured in minutes. */
export const DEFAULT_OWNER_BOOTSTRAP_WINDOW_MINUTES = 60;

/**
 * Read MEMSMITH_OWNER_BOOTSTRAP_WINDOW_MINUTES, falling back to the default for
 * anything that is not a usable positive number.
 *
 * A bare `Number(raw)` turned an operator typo into a DISABLED GATE: a
 * non-numeric value yields NaN, and `ageMinutes > NaN` is always false, so every
 * team of any age would have passed the window check. An empty string failed the
 * other way — `Number('')` is 0, an instantly-closed window that would refuse a
 * team created the same second. Neither is a security posture anyone chose; both
 * are typos. So a malformed value gets the default, which is the only value the
 * deployment can be said to have agreed to.
 *
 * Negative and zero are rejected for the same reason: a window that cannot admit
 * anyone is indistinguishable from the feature being off, and the flag already
 * expresses that intent unambiguously.
 */
export function parseWindowMinutes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OWNER_BOOTSTRAP_WINDOW_MINUTES;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_OWNER_BOOTSTRAP_WINDOW_MINUTES;
  return n;
}

export type OwnerBootstrapOutcome =
  | 'grant'
  | 'disabled'
  | 'already-owned'
  | 'window-closed'
  | 'wrong-team';

export interface OwnerBootstrapInput {
  /** MEMSMITH_ALLOW_OWNER_BOOTSTRAP. Default false. */
  enabled: boolean;
  /** MEMSMITH_OWNER_BOOTSTRAP_WINDOW_MINUTES. */
  windowMinutes: number;
  now: number;
  /** When the team row was created; null when unknown. */
  teamCreatedAtEpoch: number | null;
  /** Team named in the request path. */
  requestedTeamId: string;
  /** Team the presented key belongs to. */
  keyTeamId: string | null;
  /** user_id on the key row; null for a key minted without --user. */
  keyUserId: string | null;
  teamHasOwner: boolean;
}

export type OwnerBootstrapResult =
  | {
      outcome: 'grant';
      /** The id to record as owner — existing, or newly assigned. */
      userId: string;
      /** True when the api_keys row must be stamped with this userId. */
      stampKeyUserId: boolean;
    }
  | { outcome: Exclude<OwnerBootstrapOutcome, 'grant'>; status: number; message: string };

/**
 * Decide, from facts alone. Pure so every gate is testable without a network,
 * and so the ordering below is inspectable.
 *
 * Order matters: the FLAG is checked first, so a deployment that never opted in
 * reveals nothing about whether a team exists or is already owned.
 */
export function evaluateOwnerBootstrap(input: OwnerBootstrapInput): OwnerBootstrapResult {
  // 404, not 403: a disabled deployment should not advertise that this endpoint
  // exists at all.
  if (!input.enabled) {
    return { outcome: 'disabled', status: 404, message: 'not found' };
  }

  // A key carries one team_id, so this is what prevents cross-team escalation.
  if (!input.keyTeamId || input.keyTeamId !== input.requestedTeamId) {
    return {
      outcome: 'wrong-team', status: 403,
      message: 'this key is not for that team',
    };
  }

  // The condition that makes this a bootstrap and not a hijack.
  if (input.teamHasOwner) {
    return {
      outcome: 'already-owned', status: 409,
      message: 'this team already has an owner — ask them to grant you access',
    };
  }

  // FAIL CLOSED on an unknown creation time. An unreadable timestamp must not
  // become an unlimited window, which is what `?? Infinity` would have done.
  if (input.teamCreatedAtEpoch === null) {
    return {
      outcome: 'window-closed', status: 410,
      message: 'the setup window for this team cannot be verified',
    };
  }

  const ageMinutes = (input.now - input.teamCreatedAtEpoch) / 60_000;
  if (ageMinutes > input.windowMinutes) {
    return {
      outcome: 'window-closed', status: 410,
      message: `the setup window for this team has closed (${input.windowMinutes} minutes)`,
    };
  }

  // Assign an id when the key has none — do NOT refuse. Every key minted without
  // --user has user_id NULL (createApiKey: `input.userId ?? null`), including
  // the one a real user holds, so refusing would fail on the only case this
  // exists for. Precedent: project-identity.ts:353 backfills exactly this,
  // because a key minted before owner establishment is otherwise "permanently
  // unable to use owner-gated features".
  const existing = input.keyUserId?.trim();
  if (existing) {
    return { outcome: 'grant', userId: existing, stampKeyUserId: false };
  }
  return {
    outcome: 'grant',
    userId: `owner-${input.requestedTeamId}`,
    stampKeyUserId: true,
  };
}
