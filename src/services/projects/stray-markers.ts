// SPDX-License-Identifier: Apache-2.0
import { findNestedMarkerDirs, readMarkerAt, type ProjectMarker } from '../identity/project-identity.js';

export interface StrayMarker {
  dir: string;
  root: string;
  rootProjectId: string;
  marker: ProjectMarker;
}

/** Markers below `root`, outside nested repositories, that name a project other than the root's. */
export function findStrayMarkers(root: string, rootProjectId: string): StrayMarker[] {
  const strays: StrayMarker[] = [];
  for (const dir of findNestedMarkerDirs(root)) {
    const marker = readMarkerAt(dir);
    if (marker && marker.projectId !== rootProjectId) strays.push({ dir, root, rootProjectId, marker });
  }
  return strays;
}
