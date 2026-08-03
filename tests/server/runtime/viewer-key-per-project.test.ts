// SPDX-License-Identifier: Apache-2.0
//
// Two projects in ONE team: the viewer must hand over the RIGHT project's key.
//
// resolveViewerKeyForRequest looked the key up by TEAM:
//
//   const teamId = await deps.lookupTeamForProject(requested);
//   return deps.resolveKeyForTeam(teamId) ?? fallback;
//
// That was correct while every local project minted its own randomUUID team —
// team and project were one-to-one, so "the team's key" WAS "the project's key".
//
// A JOIN breaks that assumption. After a teammate joins, two local projects
// share one team, and CredentialStore is keyed by team alone
// (resolveKeyForTeam(teamId) — there is no per-project entry). So both projects
// resolve to whichever key was stored first.
//
// MEASURED LIVE after the join: /?project=<joiner> returned the OWNER's key, and
// /v1/identity reported the owner's projectId for the joiner's dashboard, even
// though both api_keys rows were correct and distinct:
//   8c4e121c52 | team 9902d5b8 | project 680fea00  (owner)
//   2dc597bcf2 | team 9902d5b8 | project ec958e91  (joiner)
//
// It reads as a cosmetic mix-up, but it is not: the Go Team wizard and every
// scoped write act on req.authContext.projectId, which is derived from the key
// that was handed over. Opening the joiner's dashboard and acting there would
// have operated on the OWNER's project. That is the same convert-scope leak the
// ?project= mechanism was built to close, reopened by join making the
// team->project mapping one-to-many.
//
// The fix asks the local api_keys table, which is per-project and already the
// source authContext uses, and only falls back to the team lookup when that
// finds nothing (a store predating per-project rows).
import { describe, it, expect } from 'bun:test';
import { resolveViewerKeyForRequest } from '../../../src/server/runtime/viewer-project-scope.js';

const TEAM = 'team-shared';
const OWNER_PROJECT = 'project-owner';
const JOINER_PROJECT = 'project-joiner';
const OWNER_KEY = 'cmem_owner';
const JOINER_KEY = 'cmem_joiner';

/**
 * A store keyed by TEAM only — the real CredentialStore shape. With two projects
 * in one team it can only ever return one of the two keys.
 */
function teamStore(key: string | null) {
  return (t: string) => (t === TEAM ? key : null);
}

function deps(over: Partial<Parameters<typeof resolveViewerKeyForRequest>[0]> = {}) {
  return {
    serverTeamId: TEAM,
    lookupTeamForProject: async () => TEAM,
    resolveKeyForTeam: teamStore(OWNER_KEY),
    // Per-project lookup against the local api_keys table.
    resolveKeyForProject: async (projectId: string) =>
      projectId === JOINER_PROJECT ? JOINER_KEY
        : projectId === OWNER_PROJECT ? OWNER_KEY
        : null,
    ...over,
  };
}

describe('viewer key is scoped to the PROJECT, not just the team', () => {
  it('hands the joiner its OWN key when both projects share a team', async () => {
    // THE REGRESSION. Team lookup alone returns OWNER_KEY for both.
    const key = await resolveViewerKeyForRequest({
      ...deps(),
      requestedProjectId: JOINER_PROJECT,
    });
    expect(key).toBe(JOINER_KEY);
  });

  it('still hands the owner its own key', async () => {
    const key = await resolveViewerKeyForRequest({
      ...deps(),
      requestedProjectId: OWNER_PROJECT,
    });
    expect(key).toBe(OWNER_KEY);
  });

  it('prefers the per-project key over the team key when they differ', async () => {
    // Stated as the precedence rule rather than a value, because that is the
    // contract: per-project is more specific and must win.
    const key = await resolveViewerKeyForRequest({
      ...deps({ resolveKeyForTeam: teamStore('cmem_team_wide') }),
      requestedProjectId: JOINER_PROJECT,
    });
    expect(key).toBe(JOINER_KEY);
  });
});

describe('the existing behaviour is preserved', () => {
  it('falls back to the team key when no per-project row exists', async () => {
    // A machine whose api_keys predates per-project rows, or a project that
    // never minted one. Must not regress to null.
    const key = await resolveViewerKeyForRequest({
      ...deps({ resolveKeyForProject: async () => null }),
      requestedProjectId: JOINER_PROJECT,
    });
    expect(key).toBe(OWNER_KEY);
  });

  it('uses the server project when no ?project= is given', async () => {
    const key = await resolveViewerKeyForRequest({ ...deps(), requestedProjectId: undefined });
    expect(key).toBe(OWNER_KEY);
  });

  it('falls back for an unknown project rather than failing the page', async () => {
    const key = await resolveViewerKeyForRequest({
      ...deps({ lookupTeamForProject: async () => null, resolveKeyForProject: async () => null }),
      requestedProjectId: 'nope',
    });
    expect(key).toBe(OWNER_KEY);
  });

  it('degrades to the server key when the per-project lookup THROWS', async () => {
    // A DB hiccup must not take the dashboard down.
    const key = await resolveViewerKeyForRequest({
      ...deps({ resolveKeyForProject: async () => { throw new Error('db down'); } }),
      requestedProjectId: JOINER_PROJECT,
    });
    expect(key).toBe(OWNER_KEY);
  });

  it('returns null in team mode, where there is no local key to issue', async () => {
    const key = await resolveViewerKeyForRequest({
      ...deps({ serverTeamId: null, resolveKeyForProject: async () => null, lookupTeamForProject: async () => null }),
      requestedProjectId: undefined,
    });
    expect(key).toBeNull();
  });

  it('works when no per-project resolver is supplied at all', async () => {
    // The dep is optional so existing callers/tests keep compiling.
    const { resolveKeyForProject: _omitted, ...rest } = deps();
    const key = await resolveViewerKeyForRequest({ ...rest, requestedProjectId: JOINER_PROJECT });
    expect(key).toBe(OWNER_KEY);
  });
});
