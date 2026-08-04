// SPDX-License-Identifier: Apache-2.0
//
// A join that succeeds REMOTELY but fails to apply LOCALLY must say so.
//
// applyConvertJoin returns { applied, reason } rather than throwing, and the
// join path discarded that value (ServerV1PostgresRoutes.ts:1746) while the
// convert path 135 lines later captured it (:1881). So every local refusal was
// invisible and POST /v1/join answered a clean 200 {"status":"joined"}.
//
// WHY THAT IS WORSE THAN A VISIBLE FAILURE. Two sources of truth read two
// different fields:
//   - repointLocalKeyToTeam never throws (repoint-local-key.ts:247), so the
//     local api_keys row moves to the NEW team regardless of what follows, and
//     authContext.teamId is built from that row (postgres-auth.ts:374).
//   - runtime-selector.ts:121 resolves the credential by projectMarker.teamId —
//     the MARKER, which without the flip still names the OLD team.
// The credential is therefore cached under one team and looked up by another:
// the project boots in team mode, finds no key, and silently drops every
// observation. Meanwhile JoinTeamModal.tsx:43 sees status 'joined' and calls
// onJoined(), showing the user unqualified success.
//
// There are FOUR ways to reach it, three refusals plus one skip:
//   1. no marker at the recorded path (project moved or deleted)
//   2. the marker belongs to a DIFFERENT project
//   3. the join carries no apiKey or serverUrl
//   4. projects.metadata has no memsmith_project_path, so the apply is never
//      even attempted (the :1745 guard)
//
// This tests the reporting contract in isolation: summariseLocalApply maps an
// ApplyJoinResult (or its absence) onto the fields the route adds to its
// response. The route wiring is asserted in join-local-apply-route.test.ts.
import { describe, it, expect } from 'bun:test';
import { summariseLocalApply } from '../../../src/server/convert/local-apply-report.js';

describe('summariseLocalApply', () => {
  it('reports nothing extra when the local apply succeeded', () => {
    // The common case must stay byte-identical to today's response, so a
    // successful join is not suddenly carrying new fields for clients to
    // interpret.
    expect(summariseLocalApply({ applied: true })).toEqual({});
  });

  it('reports localApplied false WITH the reason when the apply refused', () => {
    expect(summariseLocalApply({ applied: false, reason: 'no project marker at /tmp/x — nothing to flip' }))
      .toEqual({
        localApplied: false,
        localReason: 'no project marker at /tmp/x — nothing to flip',
      });
  });

  it('reports the SKIPPED case, where applyConvertJoin never ran', () => {
    // The fourth path, and the easiest to overlook: with no recorded project
    // path the route cannot even attempt the apply. Silence here would be
    // indistinguishable from success.
    expect(summariseLocalApply(null)).toEqual({
      localApplied: false,
      localReason: 'this project has no recorded directory on the server, so its '
        + 'marker could not be updated — start a session in the project to finish joining',
    });
  });

  it('supplies a reason even when the refusal carried none', () => {
    // applyConvertJoin's reason is optional in its type. A missing reason must
    // not produce `localReason: undefined`, which JSON.stringify drops — the
    // client would see localApplied:false with no explanation at all.
    const out = summariseLocalApply({ applied: false });
    expect(out.localApplied).toBe(false);
    expect(typeof out.localReason).toBe('string');
    expect(out.localReason!.length).toBeGreaterThan(0);
  });

  it('truncates an unbounded reason rather than echoing it whole', () => {
    // A reason can embed a filesystem path from the server. Cap it so the
    // response cannot be used to dump arbitrarily long server-side strings.
    const out = summariseLocalApply({ applied: false, reason: 'x'.repeat(5000) });
    expect(out.localReason!.length).toBeLessThanOrEqual(300);
  });
});
