// SPDX-License-Identifier: Apache-2.0
//
// The client half of the Go Team convert.
//
// The server copies the project's rows to the remote and returns `join`; this
// applies it locally — caching the team key and flipping the project's marker to
// server mode. It must run in the project's OWN process (the CLI/session hook),
// because that is the only process that legitimately knows where the project
// lives on disk.
//
// Previously the server did this itself via flipToTeam(cwd, ...), writing into
// the user's project directory and home directory. That only worked because
// local and server are the same machine — against a real remote team server the
// cwd is a directory on someone else's box — and the cwd it used was the
// SERVER's, so converting one project would have flipped another's marker.

import type { ConvertJoinInfo } from './convert-service.js';

export interface ApplyJoinDeps {
  readProjectMarker: (cwd: string) => { projectId: string; teamId: string } | null;
  // `teamId` is optional because only JOIN changes the team; convert omits it.
  writeProjectRuntime: (cwd: string, runtime: { runtime: 'local' | 'server'; serverUrl?: string; teamId?: string }) => void;
  storeKeyForTeam: (teamId: string, key: string) => void;
  /**
   * Permit the now-shared marker into git. Optional so existing callers and
   * unit tests are unaffected; a caller that omits it simply leaves the
   * project's .gitignore alone.
   */
  shareMarkerInGit?: (cwd: string) => { changed: boolean; reason?: string };
}

export interface ApplyJoinResult {
  applied: boolean;
  reason?: string;
  /**
   * Set when the flip succeeded but the marker could not be un-ignored. The
   * convert itself is DONE — this only means teammates will not receive the
   * marker until the user commits it by hand, so callers surface it as a hint
   * rather than an error.
   */
  markerShareFailed?: string;
}

export function applyConvertJoin(
  deps: ApplyJoinDeps,
  cwd: string,
  join: ConvertJoinInfo,
): ApplyJoinResult {
  if (!join.apiKey?.trim()) {
    // Flipping without a resolvable key strands the project: selectRuntime()
    // follows the marker immediately, so it would resolve to server mode and then
    // fail every hook with missing_api_key, silently dropping observations.
    return { applied: false, reason: 'join carried no apiKey — refusing to flip' };
  }
  if (!join.serverUrl?.trim()) {
    return { applied: false, reason: 'join carried no serverUrl — refusing to flip' };
  }

  const marker = deps.readProjectMarker(cwd);
  if (!marker) {
    // Never mint here — that would fabricate an identity for a directory that
    // was not a MemSmith project.
    return { applied: false, reason: `no project marker at ${cwd} — nothing to flip` };
  }

  // THE GUARD. The marker being flipped must be the PROJECT that was copied.
  // A mismatch is the exact bug class this design exists to eliminate (a convert
  // of one project once flipped another's marker, because the path came from the
  // server's cwd), so it fails loudly rather than picking one.
  //
  // The TEAM is deliberately NOT compared. This function serves two callers with
  // opposite invariants:
  //
  //   CONVERT — the owner pushes their own project up; the team does not change.
  //   JOIN    — a teammate attaches an existing local project to SOMEONE ELSE'S
  //             team. The team changing IS the operation.
  //
  // Requiring both to match meant every join failed the teamId half and the
  // marker was never written, so the joiner stayed on the local runtime forever.
  // Measured live: POST /v1/join returned 200 {"status":"joined"} while
  // /tmp/x/.memsmith/project.json kept its old teamId and gained no runtime
  // field — invisible because the route's apply is wrapped in a bare catch and
  // this function returns a value rather than throwing.
  //
  // The team id was never the safety property; it rode along because convert
  // happens to preserve it. "This marker belongs to the project we are acting
  // on" is the invariant that prevents the cross-project flip, and that is the
  // project id.
  if (marker.projectId !== join.projectId) {
    return {
      applied: false,
      reason: `marker at ${cwd} is project ${marker.projectId} (team ${marker.teamId}), `
        + `but the operation was for project ${join.projectId} (team ${join.teamId}) — refusing to flip`,
    };
  }

  // Key first, marker second. selectRuntime() follows the marker on its very next
  // call, so writing the marker before the key exists opens a window where the
  // project is in server mode with no credential. If the key write throws, the
  // marker is untouched and the project stays safely on local.
  // The marker adopts join.teamId. For convert this is a no-op (same team); for
  // JOIN it is required: the credential is cached under join.teamId above, and
  // buildServerContext looks the key up by the MARKER's teamId, so leaving the
  // marker on the old team means team mode with no resolvable credential.
  deps.storeKeyForTeam(join.teamId, join.apiKey);
  deps.writeProjectRuntime(cwd, {
    runtime: 'server',
    serverUrl: join.serverUrl,
    teamId: join.teamId,
  });

  // LAST, and never fatal. The project is now a team project, so its marker has
  // become shared configuration rather than machine state — a teammate cannot
  // discover the team without it, because `.memsmith/` is gitignored by default
  // and a clone would otherwise receive nothing and mint an unrelated identity.
  //
  // Ordering matters: the flip above is the operation the caller asked for and
  // has already been persisted. Un-ignoring the marker is bookkeeping on top of
  // a completed convert, so it runs after and its failure is reported, not
  // thrown — the alternative would announce a failed convert whose data is
  // already on the remote.
  const shared = deps.shareMarkerInGit?.(cwd);
  if (shared && !shared.changed && shared.reason) {
    return { applied: true, markerShareFailed: shared.reason };
  }
  return { applied: true };
}
