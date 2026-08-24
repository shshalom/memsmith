// SPDX-License-Identifier: Apache-2.0
//
// "Tracked but not joined" — the state a fresh clone is in.
//
// A teammate clones a converted project. The committed marker says
// runtime: 'server', but this machine holds no key for that team yet. Before
// this state existed, selectRuntime followed the marker straight into server
// mode, buildServerContext found no credential, and every hook logged
// `[server-fallback] reason=missing_api_key` while silently dropping the
// user's observations — on the exact machine that had just been onboarded.
//
// The rule: a marker names WHO the project is; a key decides whether this
// machine can act as it. Both are required for server mode. Anything less
// resolves local, which captures to the local database and loses nothing.

import { describe, expect, it } from 'bun:test';
import { projectJoinState, type JoinStateDeps } from '../../../src/services/identity/join-state.js';

/** Build deps with an optional marker and an optional key for a team. */
function deps(
  marker: { teamId: string; projectId: string; runtime?: string } | null,
  keyedTeams: string[] = [],
): JoinStateDeps {
  return {
    readProjectMarker: () => marker,
    hasKeyForTeam: (teamId: string) => keyedTeams.includes(teamId),
  };
}

describe('projectJoinState', () => {
  it('reports untracked when there is no marker', () => {
    // A directory nobody has minted an identity in yet.
    expect(projectJoinState('/tmp/x', deps(null))).toBe('untracked');
  });

  it('reports untracked for a local project, even when a key happens to exist', () => {
    // A local project has a teamId and a key (ensureBaseKey guarantees one), but
    // no team to join — there is nothing on the other end. Only the marker's
    // runtime distinguishes it, so a key must NOT be enough to imply team mode.
    const marker = { teamId: 't1', projectId: 'p1' };
    expect(projectJoinState('/tmp/x', deps(marker, ['t1']))).toBe('untracked');
  });

  it('reports TRACKED for a cloned team marker with no key on this machine', () => {
    // The regression this file exists for. The clone knows WHO it is and cannot
    // yet prove it may act — so it is tracked, not joined.
    const marker = { teamId: 'team-a', projectId: 'p1', runtime: 'server' };
    expect(projectJoinState('/tmp/x', deps(marker, []))).toBe('tracked');
  });

  it('reports tracked when the only key held is for a DIFFERENT team', () => {
    // The joiner already works on their own local projects, so their credential
    // store is not empty. Holding some key must not be mistaken for holding
    // THIS team's key.
    const marker = { teamId: 'team-a', projectId: 'p1', runtime: 'server' };
    expect(projectJoinState('/tmp/x', deps(marker, ['other-team']))).toBe('tracked');
  });

  it('reports joined once a key for the marker team is present', () => {
    const marker = { teamId: 'team-a', projectId: 'p1', runtime: 'server' };
    expect(projectJoinState('/tmp/x', deps(marker, ['team-a']))).toBe('joined');
  });

  it('treats the legacy server-beta runtime the same as server', () => {
    // Older markers carry 'server-beta'. If this state disagreed with
    // normalizeRuntime, a legacy team project would read untracked and lose its
    // Join button while still being a team project.
    const marker = { teamId: 'team-a', projectId: 'p1', runtime: 'server-beta' };
    expect(projectJoinState('/tmp/x', deps(marker, []))).toBe('tracked');
    expect(projectJoinState('/tmp/x', deps(marker, ['team-a']))).toBe('joined');
  });

  it('resolves untracked when the credential lookup throws', () => {
    // Fail toward local. An unreadable credential store must never be the reason
    // a project enters server mode; capture continues locally and loses nothing.
    const marker = { teamId: 'team-a', projectId: 'p1', runtime: 'server' };
    const throwing: JoinStateDeps = {
      readProjectMarker: () => marker,
      hasKeyForTeam: () => { throw new Error('unreadable credential store'); },
    };
    expect(projectJoinState('/tmp/x', throwing)).toBe('tracked');
  });

  it('resolves untracked when reading the marker throws', () => {
    const throwing: JoinStateDeps = {
      readProjectMarker: () => { throw new Error('unreadable marker'); },
      hasKeyForTeam: () => true,
    };
    expect(projectJoinState('/tmp/x', throwing)).toBe('untracked');
  });
});
