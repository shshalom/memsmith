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
  /**
   * The key belonging to THIS project specifically, from the local api_keys
   * table. Optional so existing callers keep working; when absent the team
   * lookup below is the only path (the pre-join behaviour).
   */
  resolveKeyForProject?: (projectId: string) => Promise<string | null>;
  /**
   * Can the LOCAL server validate this key (is its hash in local api_keys)?
   *
   * After a join, CredentialStore holds the TEAM's key — minted on the remote,
   * absent from the local table. Issuing it as the viewer cookie made every
   * request 403, which is worse than issuing nothing: the tracked-view grant
   * answers a request that presents no credential at all. Optional so existing
   * callers and tests are unaffected; when absent the old behaviour stands.
   */
  isKeyValidLocally?: (key: string) => Promise<boolean>;
}

export async function resolveViewerKeyForRequest(deps: ViewerProjectScopeDeps): Promise<string | null> {
  const fallback = deps.serverTeamId ? deps.resolveKeyForTeam(deps.serverTeamId) : null;

  const requested = deps.requestedProjectId?.trim();
  if (!requested) return fallback;

  try {
    // PER-PROJECT FIRST. Resolving by team alone was correct only while every
    // local project minted its own randomUUID team — one team, one project, so
    // "the team's key" WAS "the project's key".
    //
    // A JOIN breaks that: two local projects then share one team, and
    // CredentialStore is keyed by team alone (there is no per-project entry), so
    // both projects resolved to whichever key happened to be stored first.
    // Measured after a live join: /?project=<joiner> handed back the OWNER's key
    // and /v1/identity reported the owner's projectId on the joiner's dashboard.
    //
    // Not cosmetic. The Go Team wizard and every scoped write act on
    // req.authContext.projectId, which comes from the key that was issued — so
    // acting on the joiner's dashboard would have operated on the OWNER's
    // project. That is the convert-scope leak ?project= exists to close,
    // reopened by join making team -> project one-to-many.
    //
    // api_keys is per-project and is already what authContext derives from, so
    // it is the authoritative answer to "which key is this project's".
    if (deps.resolveKeyForProject) {
      const own = await deps.resolveKeyForProject(requested);
      if (own) return own;
    }
    const teamId = await deps.lookupTeamForProject(requested);
    // NO FALLBACK ONCE A PROJECT WAS NAMED.
    //
    // These three paths used to `?? fallback` — the SERVER's key. So asking for
    // a project this machine holds no key for silently authenticated the browser
    // as the server's project while the URL still named the requested one. That
    // is the same view/credential disagreement behind every other bug in this
    // area (bare-load re-scoping, sidebar vs Runtime tile, team-scoped keys
    // leaking across a join), and it is what made the dashboard answer with the
    // dogfood's project for a "tracked but not joined" project — the state the
    // joiner feature is built on.
    //
    // Silently showing a DIFFERENT project than the one asked for is worse than
    // showing none: the Go Team wizard acts on whatever the request
    // authenticates as. Returning null makes the caller's failure explicit
    // rather than mislabelling someone else's data.
    if (!teamId) return null;
    const teamKey = deps.resolveKeyForTeam(teamId);
    if (!teamKey) return null;

    // ONLY HAND OVER A KEY THE LOCAL SERVER CAN VALIDATE.
    //
    // CredentialStore holds whatever key a project uses — and after a JOIN that
    // is the TEAM's key, minted on the remote. The local server validates keys
    // against its own api_keys table, which has no such row, so issuing it as
    // the viewer cookie made every request 403: worse than issuing nothing,
    // because the tracked-view grant answers a request that presents NO
    // credential. Measured live: bare request 200, same request with the cookie
    // 403, and the dashboard rendered "runtime unavailable" with empty Settings.
    //
    // So verify it locally before handing it over. If the hash is absent this
    // returns null, the viewer issues no cookie, and the grant serves the page.
    if (deps.isKeyValidLocally) {
      const usable = await deps.isKeyValidLocally(teamKey);
      if (!usable) return null;
    }
    return teamKey;
  } catch {
    // A lookup failure must not break the page — but it must not mislabel the
    // page either. No key: the viewer renders unauthenticated for the project
    // that was asked for.
    return null;
  }
}
