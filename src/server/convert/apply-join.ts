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
  writeProjectRuntime: (cwd: string, runtime: { runtime: 'local' | 'server'; serverUrl?: string }) => void;
  storeKeyForTeam: (teamId: string, key: string) => void;
}

export interface ApplyJoinResult {
  applied: boolean;
  reason?: string;
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

  // THE GUARD. The marker being flipped must be the project that was copied.
  // A mismatch is the exact bug class this design exists to eliminate, so it
  // fails loudly rather than picking one.
  if (marker.projectId !== join.projectId || marker.teamId !== join.teamId) {
    return {
      applied: false,
      reason: `marker at ${cwd} is project ${marker.projectId} (team ${marker.teamId}), `
        + `but the convert was for project ${join.projectId} (team ${join.teamId}) — refusing to flip`,
    };
  }

  // Key first, marker second. selectRuntime() follows the marker on its very next
  // call, so writing the marker before the key exists opens a window where the
  // project is in server mode with no credential. If the key write throws, the
  // marker is untouched and the project stays safely on local.
  deps.storeKeyForTeam(join.teamId, join.apiKey);
  deps.writeProjectRuntime(cwd, { runtime: 'server', serverUrl: join.serverUrl });
  return { applied: true };
}
