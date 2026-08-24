// SPDX-License-Identifier: Apache-2.0
//
// Is this project tracked by a team, and may THIS machine act as it?
//
// A marker names WHO a project is; a key decides whether this machine can act
// as it. The two are deliberately stored apart — the marker is a non-secret
// pointer that ships in the repo, the key lives only in ~/.memsmith — so a
// freshly cloned project routinely has the first without the second.
//
// That combination had no name, and so no handling. selectRuntime followed the
// marker straight into server mode, buildServerContext found no credential, and
// every hook logged `[server-fallback] reason=missing_api_key` while silently
// dropping observations. The machine that had just been onboarded was the one
// machine guaranteed to lose work.
//
// Naming the state fixes three things at once with one rule: the runtime gate
// (stay local until joinable), the install prompt (offer to join), and the
// dashboard Join button — which previously asked the LOCAL database whether a
// team existed, so it was invisible on exactly the clone that needed it.
//
// The product rule this encodes, from the product owner: "if identity exists
// and the user didn't join then the work is offline / local... minting identity
// is when one does not exist."

/** What a directory is, with respect to a team. */
export type JoinState =
  /** No marker, or a marker for a purely local project. Nothing to join. */
  | 'untracked'
  /** A team project this machine holds no key for. Capture stays LOCAL. */
  | 'tracked'
  /** A team project this machine can authenticate as. */
  | 'joined';

export interface JoinStateDeps {
  readProjectMarker: (cwd: string) => { teamId: string; projectId: string; runtime?: string } | null;
  hasKeyForTeam: (teamId: string) => boolean;
}

/**
 * Classify a directory. NEVER throws.
 *
 * Every failure resolves toward the safer answer. An unreadable marker is
 * `untracked`; an unreadable credential store is `tracked`, not `joined`. Both
 * land the caller on the local runtime, which captures to the local database
 * and loses nothing. The inverse — entering server mode on a failed read — is
 * the silent-drop failure this module exists to prevent, so no error path may
 * ever produce `joined`.
 */
export function projectJoinState(cwd: string, deps: JoinStateDeps): JoinState {
  let marker: { teamId: string; projectId: string; runtime?: string } | null;
  try {
    marker = deps.readProjectMarker(cwd);
  } catch {
    return 'untracked';
  }
  if (!marker) return 'untracked';

  // Accept the legacy 'server-beta' literal alongside 'server', matching
  // normalizeRuntime. If this disagreed, a legacy team project would read
  // untracked and lose its Join button while still being a team project.
  const isTeam = marker.runtime === 'server' || marker.runtime === 'server-beta';
  if (!isTeam) return 'untracked';

  try {
    return deps.hasKeyForTeam(marker.teamId) ? 'joined' : 'tracked';
  } catch {
    return 'tracked';
  }
}
