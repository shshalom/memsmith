// SPDX-License-Identifier: Apache-2.0
//
// Pick which project's credential the local dashboard should be handed.
//
// One server serves every local project, but the viewer cookie previously
// always carried the key for the SERVER's own cwd. Opening the dashboard while
// working in a different project therefore showed the server's project -- and
// worse, the Go Team wizard converts req.authContext.projectId, so clicking it
// from a second project would have targeted the FIRST project's memory.
//
// `GET /?project=<projectId>` selects the credential instead. Each project
// mints its own team and its own key, so choosing the key scopes reads, writes
// and convert together; there is no separate scope to keep in sync.
//
// Authorization: the machine must already hold that team's key in its own
// CredentialStore. This grants nothing new -- the key is on this disk, and the
// route issuing it is loopback-gated. An unknown project, or one whose key this
// machine does not hold, quietly falls back to the server's own project rather
// than failing the page.

export interface ViewerProjectScopeDeps {
  // Raw ?project= value, if present.
  requestedProjectId?: string | undefined;
  // Team of the project the server booted from; null in team/server mode.
  serverTeamId: string | null;
  lookupTeamForProject: (projectId: string) => Promise<string | null>;
  resolveKeyForTeam: (teamId: string) => string | null;
}

export async function resolveViewerKeyForRequest(deps: ViewerProjectScopeDeps): Promise<string | null> {
  const fallback = deps.serverTeamId ? deps.resolveKeyForTeam(deps.serverTeamId) : null;

  const requested = deps.requestedProjectId?.trim();
  if (!requested) return fallback;

  try {
    const teamId = await deps.lookupTeamForProject(requested);
    if (!teamId) return fallback;
    // Only hand over a credential this machine already holds.
    return deps.resolveKeyForTeam(teamId) ?? fallback;
  } catch {
    // A lookup failure must not break the page; degrade to the server project.
    return fallback;
  }
}
