// SPDX-License-Identifier: Apache-2.0
//
// Per-project runtime resolution for GET /v1/projects.
//
// This previously read the SERVER's own marker and compared its projectId to each
// row, so ONLY the project the server was launched from could ever report "team".
// Every other project was hardcoded 'local' regardless of its real marker — which
// is why a freshly converted project still showed "Local" in the switcher and the
// GO TEAM button stayed visible on a project already in team mode.
//
// That was the fourth instance of the server-cwd pattern behind tonight's
// cross-project copy, and it survived an audit because the endpoint DOES read
// authContext — just for a different field (isCurrent), not for runtime.
//
// Each project's runtime now comes from ITS OWN marker, found via the path
// recorded in projects.metadata. The path is a hint, not authority: a project can
// be moved and another can take its directory, so a marker whose projectId no
// longer matches is ignored rather than trusted. Fail-safe to 'local' throughout —
// this runs per row on a dashboard list, and one unreadable marker must not break
// the whole switcher.

import { PROJECT_PATH_KEY } from '../../../services/identity/project-identity.js';

export interface ProjectRuntimeRow {
  projectId: string;
  metadata: Record<string, unknown> | null;
}

/** Reads the marker at a path. Returns null when absent/unreadable. */
export type MarkerReader = (path: string) => { projectId: string; runtime?: string } | null;

export function resolveProjectRuntime(
  row: ProjectRuntimeRow,
  readMarker: MarkerReader,
): 'local' | 'team' {
  const path = row.metadata?.[PROJECT_PATH_KEY];
  // No recorded path: minted before path recording, heals on its next session.
  // 'local' is the safe answer — never guess from the server's cwd.
  if (typeof path !== 'string' || !path.trim()) return 'local';

  let marker: { projectId: string; runtime?: string } | null = null;
  try {
    marker = readMarker(path);
  } catch {
    return 'local';
  }
  if (!marker) return 'local';

  // The marker must still belong to THIS project. A stale path pointing at a
  // different project's marker would attribute that project's runtime to this one.
  if (marker.projectId !== row.projectId) return 'local';

  // Accept the legacy 'server-beta' literal alongside 'server'. Markers written
  // before the rename still carry it and normalizeRuntime still honours it, so
  // matching only 'server' silently demotes a real team project to local — which
  // in turn hides the Join button and the team badge for it.
  return marker.runtime === 'server' || marker.runtime === 'server-beta'
    ? 'team'
    : 'local';
}
