import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { resolveDashboardPort } from '../../shared/dashboard-url.js';
import {
  buildServerContext,
  normalizeRuntime,
  selectRuntime,
  type ServerRuntimeContext,
} from '../hooks/runtime-selector.js';
import { ServerClient } from '../hooks/server-client.js';
import { CredentialStore } from './credential-store.js';
import { readProjectMarker, type ProjectMarker } from './project-identity.js';

export type FolderProjectResolution =
  | { kind: 'resolved'; ctx: ServerRuntimeContext }
  | { kind: 'no_project'; folder: string }
  | { kind: 'no_key'; folder: string; projectId: string; team: boolean }
  | { kind: 'no_team_server'; folder: string; projectId: string }
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
  const store = options.credentialStore ?? new CredentialStore();
  if (options.pinToMarker) {
    return marker ? resolvePinnedMarker(folder, marker, store) : { kind: 'no_project', folder };
  }
  const ctx = buildServerContext({ cwd: folder, credentialStore: store });
  if (ctx) return { kind: 'resolved', ctx };
  if (!marker) return { kind: 'no_project', folder };
  if (!store.resolveKeyFor(marker)) {
    return { kind: 'no_key', folder, projectId: marker.projectId, team: marker.runtime === 'server' };
  }
  return { kind: 'unconfigured', folder };
}

function firstNonEmpty(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

// A key only ever goes to its own team's server. The settings key carries no
// team id, so it is trusted for a marker only when settings name that same
// project or the marker names the settings server (where that key already
// goes); any other team needs its own cached key. A team marker that names no
// server sends nothing, even with a cached key.
function resolvePinnedMarker(folder: string, marker: ProjectMarker, store: CredentialStore): FolderProjectResolution {
  const settings = loadFromFileOnce();
  const settingsKey = firstNonEmpty(settings.MEMSMITH_SERVER_API_KEY, settings.MEMSMITH_SERVER_BETA_API_KEY);
  const settingsProject = firstNonEmpty(settings.MEMSMITH_SERVER_PROJECT_ID, settings.MEMSMITH_SERVER_BETA_PROJECT_ID);
  const settingsUrl = firstNonEmpty(settings.MEMSMITH_SERVER_URL, settings.MEMSMITH_SERVER_BETA_URL);
  const settingsAreLocal = normalizeRuntime(settings.MEMSMITH_RUNTIME) === 'local';
  const isTeam = marker.runtime === 'server';

  const settingsKeyFits = settingsProject === marker.projectId
    || (marker.serverUrl !== undefined && settingsUrl !== '' && sameUrl(marker.serverUrl, settingsUrl));
  const apiKey = store.resolveKeyFor(marker) ?? (settingsKey && settingsKeyFits ? settingsKey : null);
  if (!apiKey) return { kind: 'no_key', folder, projectId: marker.projectId, team: isTeam };
  if (isTeam && !marker.serverUrl) return { kind: 'no_team_server', folder, projectId: marker.projectId };

  const localUrl = settingsAreLocal && settingsUrl ? settingsUrl : `http://127.0.0.1:${resolveDashboardPort()}`;
  const serverBaseUrl = marker.serverUrl ?? localUrl;

  const client = new ServerClient({ serverBaseUrl, apiKey, delegateGeneration: selectRuntime(folder) === 'server' });
  return { kind: 'resolved', ctx: { runtime: 'server', client, projectId: marker.projectId, serverBaseUrl } };
}

export type UnusableFolderProject = Exclude<FolderProjectResolution, { kind: 'resolved' }>;

/**
 * Explains why a folder has no usable project. `consequence` states what did
 * not happen, so a caller never reads the refusal as an empty result.
 */
export function describeUnusableProject(
  resolution: UnusableFolderProject,
  consequence: string,
  noProjectHint: string,
): string[] {
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
    case 'no_team_server':
      return [
        `The folder ${resolution.folder} belongs to MemSmith project ${resolution.projectId}, but its team server is unknown. ${consequence}`,
        'To rejoin the team, open the MemSmith dashboard and choose Join on the Runtime tile.',
      ];
    case 'unconfigured':
      return [
        `The folder ${resolution.folder} has a MemSmith project, but the MemSmith server settings are incomplete. ${consequence}`,
        'To repair the settings, run: npx memsmith install',
      ];
  }
}
