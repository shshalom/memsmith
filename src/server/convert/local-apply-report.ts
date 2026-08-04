// SPDX-License-Identifier: Apache-2.0
//
// Telling the caller that a join succeeded REMOTELY but not LOCALLY.
//
// applyConvertJoin returns { applied, reason } instead of throwing, and the join
// path discarded that value while the convert path 135 lines away captured it.
// Every local refusal was therefore invisible: POST /v1/join answered a clean
// 200 {"status":"joined"} and JoinTeamModal called onJoined(), so the user saw
// unqualified success.
//
// WHY SILENCE IS THE WORST OUTCOME HERE. Two sources of truth read two different
// fields, and a skipped marker flip splits them:
//   - repointLocalKeyToTeam never throws (repoint-local-key.ts:247), so the local
//     api_keys row moves to the NEW team regardless of what happens next, and
//     authContext.teamId is built from that row (postgres-auth.ts:374).
//   - runtime-selector.ts:121 resolves the credential by projectMarker.teamId —
//     the MARKER, which without the flip still names the OLD team.
// The credential ends up cached under one team and looked up by another, so the
// project boots into team mode, resolves no key, and silently drops every
// observation. A user told "joined" has no reason to suspect any of it.
//
// This does NOT make a local failure fail the join. The remote side is already
// committed by the time it runs, and it is genuinely recoverable on the
// project's next session — so the join stays a 200 and gains a qualifier. That
// keeps the existing contract (status 'joined' means the team accepted you)
// while making the local half legible.

/** The shape applyConvertJoin returns. Local mirror to avoid a circular import. */
export interface LocalApplyOutcome {
  applied: boolean;
  reason?: string;
}

/** Extra fields the join response carries when the local apply did not happen. */
export interface LocalApplyReport {
  localApplied?: false;
  localReason?: string;
}

/**
 * Longest reason echoed to the client.
 *
 * Reasons embed a filesystem path from the server (`no project marker at
 * ${cwd}`), so the length is attacker-influenced in the sense that it is not
 * bounded by anything this code controls. Cap it rather than relay an
 * arbitrarily long server-side string into an HTTP response.
 */
const MAX_REASON = 300;

/** What to say when the apply was never attempted at all. */
const NO_PATH_REASON =
  'this project has no recorded directory on the server, so its marker could not '
  + 'be updated — start a session in the project to finish joining';

function clamp(reason: string): string {
  return reason.length <= MAX_REASON ? reason : `${reason.slice(0, MAX_REASON - 1)}…`;
}

/**
 * Map a local-apply outcome onto the fields the join response should carry.
 *
 * `null` means applyConvertJoin was never called — the route's
 * `memsmith_project_path` guard found no recorded directory. That is a fourth
 * failure mode alongside applyConvertJoin's three refusals, and the easiest to
 * miss, because nothing throws and nothing returns.
 *
 * Success returns an EMPTY object on purpose: the overwhelmingly common response
 * stays byte-identical to today's, so no client has to learn a new field to
 * understand an ordinary join.
 */
export function summariseLocalApply(outcome: LocalApplyOutcome | null): LocalApplyReport {
  if (outcome === null) {
    return { localApplied: false, localReason: NO_PATH_REASON };
  }
  if (outcome.applied) return {};
  // `reason` is optional in applyConvertJoin's type. Never emit
  // `localReason: undefined` — JSON.stringify drops undefined values, so the
  // client would receive localApplied:false with no explanation whatsoever.
  const reason = outcome.reason?.trim();
  return {
    localApplied: false,
    localReason: clamp(reason || 'the local apply did not complete'),
  };
}
