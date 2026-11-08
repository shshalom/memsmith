import { buildServerContext, type ServerRuntimeContext } from '../hooks/runtime-selector.js';
import { CredentialStore } from './credential-store.js';
import { readProjectMarker } from './project-identity.js';

export type FolderProjectResolution =
  | { kind: 'resolved'; ctx: ServerRuntimeContext }
  | { kind: 'no_project'; folder: string }
  | { kind: 'no_key'; folder: string; projectId: string; team: boolean }
  | { kind: 'unconfigured'; folder: string };

export interface ResolveFolderProjectOptions {
  // A folder the caller named explicitly is authoritative: its marker decides
  // the project even when settings hold a team-mode project, and a folder with
  // no marker resolves to no project at all.
  pinToMarker?: boolean;
  credentialStore?: CredentialStore;
}

export function resolveFolderProject(folder: string, options: ResolveFolderProjectOptions = {}): FolderProjectResolution {
  const marker = readProjectMarker(folder);
  if (options.pinToMarker && !marker) return { kind: 'no_project', folder };
  const ctx = buildServerContext({ cwd: folder, ...(options.credentialStore ? { credentialStore: options.credentialStore } : {}) });
  if (ctx) {
    return { kind: 'resolved', ctx: options.pinToMarker && marker ? { ...ctx, projectId: marker.projectId } : ctx };
  }
  if (!marker) return { kind: 'no_project', folder };
  const store = options.credentialStore ?? new CredentialStore();
  if (!store.resolveKeyForTeam(marker.teamId)) {
    return { kind: 'no_key', folder, projectId: marker.projectId, team: marker.runtime === 'server' };
  }
  return { kind: 'unconfigured', folder };
}

/**
 * Explains why a folder has no usable project. `consequence` states what did
 * not happen, so a caller never reads the refusal as an empty result.
 * Returns null for 'resolved' and 'unconfigured', which callers report themselves.
 */
export function describeUnusableProject(
  resolution: FolderProjectResolution,
  consequence: string,
  noProjectHint: string,
): string[] | null {
  switch (resolution.kind) {
    case 'no_project':
      return [`No MemSmith project found for ${resolution.folder}. ${consequence}`, noProjectHint];
    case 'no_key':
      return resolution.team
        ? [
          `The folder ${resolution.folder} belongs to MemSmith project ${resolution.projectId} in a team this machine hasn't joined. ${consequence}`,
          'To join the team, open the MemSmith dashboard and choose Join on the Runtime tile.',
        ]
        : [
          `The folder ${resolution.folder} belongs to MemSmith project ${resolution.projectId}, but this machine holds no key for it. ${consequence}`,
          'To restore the key, start a MemSmith session in that folder.',
        ];
    default:
      return null;
  }
}
