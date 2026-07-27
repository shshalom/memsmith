// SPDX-License-Identifier: Apache-2.0
//
// The dashboard cookie always carried the key for the SERVER's cwd, so opening
// the dashboard from any other project still showed -- and acted on -- the
// server's own project. That is not merely cosmetic: the Go Team wizard
// converts req.authContext.projectId, so clicking it from a second project
// would have targeted the FIRST project's memory.
//
// GET /?project=<projectId> now issues the cookie for THAT project's key.
// Each project mints its own team and its own key, so scoping the key scopes
// everything downstream: reads, writes, and convert.
import { describe, it, expect } from 'bun:test';
import { resolveViewerKeyForRequest } from '../../../src/server/runtime/viewer-project-scope.js';

const SERVER_TEAM = 'team-server';
const SERVER_PROJECT = 'proj-server';
const OTHER_TEAM = 'team-other';
const OTHER_PROJECT = 'proj-other';

const KEYS: Record<string, string> = {
  [SERVER_TEAM]: 'cmem_serverkey',
  [OTHER_TEAM]: 'cmem_otherkey',
};

function deps(overrides: Partial<Parameters<typeof resolveViewerKeyForRequest>[0]> = {}) {
  return {
    requestedProjectId: undefined as string | undefined,
    serverTeamId: SERVER_TEAM,
    lookupTeamForProject: async (projectId: string) =>
      projectId === OTHER_PROJECT ? OTHER_TEAM
        : projectId === SERVER_PROJECT ? SERVER_TEAM
          : null,
    resolveKeyForTeam: (teamId: string) => KEYS[teamId] ?? null,
    ...overrides,
  };
}

describe('viewer project scoping', () => {
  it('defaults to the server cwd project when no ?project= is given', async () => {
    expect(await resolveViewerKeyForRequest(deps())).toBe('cmem_serverkey');
  });

  it('issues ANOTHER project\'s key when ?project= names it', async () => {
    // The property that unblocks P3: the dashboard, and therefore Go Team,
    // acts on the requested project rather than the server's own.
    expect(await resolveViewerKeyForRequest(deps({ requestedProjectId: OTHER_PROJECT })))
      .toBe('cmem_otherkey');
  });

  it('falls back to the server key for an unknown project id', async () => {
    expect(await resolveViewerKeyForRequest(deps({ requestedProjectId: 'nope' })))
      .toBe('cmem_serverkey');
  });

  it('falls back to the server key when the machine holds no key for that team', async () => {
    // A project known to the DB but whose credential this machine does not
    // hold must not silently grant access to it.
    const d = deps({
      requestedProjectId: OTHER_PROJECT,
      resolveKeyForTeam: (t: string) => (t === SERVER_TEAM ? 'cmem_serverkey' : null),
    });
    expect(await resolveViewerKeyForRequest(d)).toBe('cmem_serverkey');
  });

  it('returns null when there is no server key either (team mode: no cookie)', async () => {
    const d = deps({ serverTeamId: null, resolveKeyForTeam: () => null });
    expect(await resolveViewerKeyForRequest(d)).toBeNull();
  });

  it('ignores an empty or whitespace-only ?project=', async () => {
    expect(await resolveViewerKeyForRequest(deps({ requestedProjectId: '' }))).toBe('cmem_serverkey');
    expect(await resolveViewerKeyForRequest(deps({ requestedProjectId: '   ' }))).toBe('cmem_serverkey');
  });

  it('survives a lookup failure by falling back to the server key', async () => {
    const d = deps({
      requestedProjectId: OTHER_PROJECT,
      lookupTeamForProject: async () => { throw new Error('db down'); },
    });
    expect(await resolveViewerKeyForRequest(d)).toBe('cmem_serverkey');
  });
});
