// SPDX-License-Identifier: Apache-2.0
//
// Session-start claim of a pending Go Team join — the step that completes a
// convert.
//
// The server copied the data and left a note on the destination database, because
// it must not write this project's marker: one shared server can only guess at
// project directories, and guessing is exactly what let a convert of one project
// flip another's marker. This runs in the project's OWN process, so the directory
// is not a guess.
//
// Fail-safe throughout. This runs on every session start, so any failure leaves
// the project on local with its data intact and the note still pending for the
// next session to retry. A convert that completes late is recoverable; a session
// that cannot start is not.

import { readPendingJoin, clearPendingJoin } from './pending-join.js';
import type { ApplyJoinResult } from './apply-join.js';

interface NotePool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ClaimDeps {
  readProjectMarker: (cwd: string) => { projectId: string; teamId: string; runtime?: string } | null;
  resolveKeyForTeam: (teamId: string) => string | null;
  /**
   * The LOCAL base-account database, where `projects` rows live.
   *
   * Deliberately not the destination: an earlier attempt put the note on the
   * remote, which is circular — reaching the remote requires its URL, and that URL
   * is what the note carries. Both the server (this.options.pool) and this hook
   * (baseAccountPool, opened moments earlier for identity minting) are already
   * connected here, so neither side needs anything it does not already have.
   */
  pool: NotePool;
  applyJoin: (
    cwd: string,
    join: { teamId: string; projectId: string; serverUrl: string; apiKey: string },
  ) => ApplyJoinResult;
}

export async function claimPendingTeamJoin(
  cwd: string,
  deps: ClaimDeps,
): Promise<{ applied: boolean; reason?: string }> {
  const marker = deps.readProjectMarker(cwd);
  // Not a MemSmith project. Never mint here — that would fabricate an identity.
  if (!marker) return { applied: false, reason: 'no project marker' };

  // Already converted. Skip the remote round-trip on every subsequent session
  // start rather than re-querying forever.
  if (marker.runtime === 'server') return { applied: false, reason: 'already on server runtime' };

  // The note carries no credential by design; the key comes from the local store,
  // where the convert's mint cached it. No key means no way to reach the
  // destination — and flipping regardless would strand the project in server mode
  // with nothing to authenticate with.
  const apiKey = deps.resolveKeyForTeam(marker.teamId);
  if (!apiKey) return { applied: false, reason: 'no cached key for this team' };

  try {
    const pool = deps.pool;
    const note = await readPendingJoin(pool, marker.projectId);
    if (!note) return { applied: false, reason: 'no pending join' };

    // The note's team must match this project's own marker, or the key we just
    // resolved is for a different team than the note describes.
    if (note.teamId !== marker.teamId) {
      return { applied: false, reason: 'pending join is for a different team' };
    }

    const result = deps.applyJoin(cwd, {
      teamId: note.teamId,
      projectId: marker.projectId,
      serverUrl: note.serverUrl,
      apiKey,
    });

    // Clear ONLY on success. A refusal (e.g. project mismatch) must leave the note
    // in place so the condition stays visible rather than being swallowed.
    if (result.applied) await clearPendingJoin(pool, marker.projectId);
    return result;
  } catch (err) {
    // Never throw: this runs on every session start. A failure leaves the project
    // on local with its data intact and the note still pending to retry.
    return { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
