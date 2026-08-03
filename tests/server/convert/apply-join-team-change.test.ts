// SPDX-License-Identifier: Apache-2.0
//
// A JOIN changes the project's team. The guard treated that as a mismatch.
//
// applyConvertJoin serves two callers with opposite invariants:
//
//   CONVERT — the owner pushes their own project up. The team does NOT change:
//             marker.teamId === join.teamId always holds.
//   JOIN    — a teammate attaches an existing local project to SOMEONE ELSE'S
//             team. The team DOES change, by definition. That is the operation.
//
// The guard required BOTH to match:
//
//   if (marker.projectId !== join.projectId || marker.teamId !== join.teamId)
//     return { applied: false, reason: '... refusing to flip' };
//
// so every join failed the teamId half and the marker was never written. The
// joiner stayed on the local runtime permanently.
//
// MEASURED LIVE against the rig, after the remote-key-hash fix made the accept
// path reachable at all:
//   POST /v1/join            -> 200 {"status":"joined", join:{teamId:9902d5b8…}}
//   /tmp/x/.memsmith/project.json -> STILL teamId d51b7678…, no runtime field
//   applyConvertJoin reason  -> "marker at /tmp/x is project ec958e91 (team
//                               d51b7678), but the convert was for project
//                               ec958e91 (team 9902d5b8) — refusing to flip"
//
// Project id identical, team id different: the exact success shape of a join.
//
// The failure was INVISIBLE because the route's apply is wrapped in a bare
// `catch {}` and applyConvertJoin returns a value rather than throwing, so a
// refusal is indistinguishable from success at the HTTP layer. The user is told
// "joined" and gets no team memory.
//
// WHAT THE GUARD IS ACTUALLY FOR — worth stating, because loosening it wrongly
// would reintroduce the bug it was built to stop: a convert of one project once
// flipped ANOTHER project's marker, because the path came from the server's cwd.
// The protection that matters is "this marker belongs to the project we are
// acting on" — i.e. the PROJECT id. The team id was never the safety property;
// it rode along because convert happens to preserve it.
//
// So projectId stays strict, and the team is allowed to change. A join that
// moved a DIFFERENT project's marker is still refused.
import { describe, it, expect } from 'bun:test';
import { applyConvertJoin } from '../../../src/server/convert/apply-join.js';

const OWNER_TEAM = 'team-owner';
const JOINER_TEAM = 'team-joiner';
const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';

function harness(marker: { projectId: string; teamId: string } | null) {
  const wrote: Array<{ cwd: string; runtime: string; serverUrl?: string; teamId?: string }> = [];
  const keys: Array<{ teamId: string; key: string }> = [];
  return {
    wrote,
    keys,
    deps: {
      readProjectMarker: () => marker as never,
      writeProjectRuntime: (cwd: string, opts: { runtime: string; serverUrl?: string; teamId?: string }) => {
        wrote.push({ cwd, ...opts });
      },
      storeKeyForTeam: (teamId: string, key: string) => { keys.push({ teamId, key }); },
    },
  };
}

const join = {
  teamId: OWNER_TEAM,
  projectId: PROJECT,
  serverUrl: 'http://127.0.0.1:38879',
  apiKey: 'cmem_invited',
};

describe('applyConvertJoin allows the team to CHANGE (the join case)', () => {
  it('flips the marker when the project matches but the team differs', () => {
    // THE REGRESSION. This is what a real join looks like: same project,
    // different team. It was refused, so no teammate could ever leave local mode.
    const h = harness({ projectId: PROJECT, teamId: JOINER_TEAM });
    const result = applyConvertJoin(h.deps, '/tmp/x', join);
    expect(result.applied).toBe(true);
    expect(h.wrote).toHaveLength(1);
    expect(h.wrote[0]!.runtime).toBe('server');
  });

  it('adopts the NEW team id, not the stale local one', () => {
    // Flipping to server mode while caching the key under the OLD team would
    // leave the project authenticated as nobody — the failure the key-first
    // ordering exists to prevent.
    const h = harness({ projectId: PROJECT, teamId: JOINER_TEAM });
    applyConvertJoin(h.deps, '/tmp/x', join);
    expect(h.keys).toEqual([{ teamId: OWNER_TEAM, key: 'cmem_invited' }]);
  });

  it('writes the key BEFORE the marker, so team mode always has a credential', () => {
    // Ordering is load-bearing: selectRuntime() follows the marker on its very
    // next call, so a marker written first opens a window with no credential.
    const order: string[] = [];
    const result = applyConvertJoin(
      {
        readProjectMarker: () => ({ projectId: PROJECT, teamId: JOINER_TEAM }) as never,
        writeProjectRuntime: () => { order.push('marker'); },
        storeKeyForTeam: () => { order.push('key'); },
      },
      '/tmp/x',
      join,
    );
    expect(result.applied).toBe(true);
    expect(order).toEqual(['key', 'marker']);
  });

  it('still works for convert, where the team does NOT change', () => {
    // The original caller must be unaffected.
    const h = harness({ projectId: PROJECT, teamId: OWNER_TEAM });
    expect(applyConvertJoin(h.deps, '/tmp/x', join).applied).toBe(true);
  });

  it('writes the NEW teamId into the marker, not the stale local one', () => {
    // THE THIRD LAYER. Letting the guard through was not enough:
    // writeProjectRuntime merges `...existing`, so the marker kept the joiner's
    // ORIGINAL teamId while flipping runtime to 'server'.
    //
    // That combination is the specific failure the key-first ordering exists to
    // prevent, arrived at from the other side. buildServerContext resolves the
    // credential with resolveKeyForTeam(projectMarker.teamId)
    // (src/services/hooks/runtime-selector.ts:121), and the key was cached under
    // the OWNER's team. So the joiner boots in team mode, looks up a key for a
    // team it no longer belongs to, finds none, and silently drops observations.
    //
    // Marker team and credential team must be the same team.
    const h = harness({ projectId: PROJECT, teamId: JOINER_TEAM });
    applyConvertJoin(h.deps, '/tmp/x', join);
    expect(h.wrote[0]!.teamId).toBe(OWNER_TEAM);
    expect(h.keys[0]!.teamId).toBe(OWNER_TEAM);
    // Stated as the invariant rather than two separate values, because it is the
    // relationship that matters: a future change may alter which team is adopted,
    // but these two must never disagree.
    expect(h.wrote[0]!.teamId).toBe(h.keys[0]!.teamId);
  });
});

describe('the projectId guard stays strict', () => {
  it('refuses when the marker belongs to a DIFFERENT project', () => {
    // The bug this guard exists for: a convert once flipped another project's
    // marker because the path came from the server's cwd. Allowing the team to
    // change must not weaken this.
    const h = harness({ projectId: OTHER_PROJECT, teamId: OWNER_TEAM });
    const result = applyConvertJoin(h.deps, '/tmp/x', join);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain(OTHER_PROJECT);
    expect(h.wrote).toHaveLength(0);
    expect(h.keys).toHaveLength(0);
  });

  it('refuses a different project even when its team already matches', () => {
    // Guards against a fix that drops the projectId check along with the team.
    const h = harness({ projectId: OTHER_PROJECT, teamId: JOINER_TEAM });
    expect(applyConvertJoin(h.deps, '/tmp/x', join).applied).toBe(false);
    expect(h.wrote).toHaveLength(0);
  });

  it('refuses when there is no marker at all — never fabricates identity', () => {
    const h = harness(null);
    const result = applyConvertJoin(h.deps, '/tmp/x', join);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('no project marker');
  });

  it('refuses without an apiKey, so team mode is never credential-less', () => {
    const h = harness({ projectId: PROJECT, teamId: JOINER_TEAM });
    const result = applyConvertJoin(h.deps, '/tmp/x', { ...join, apiKey: '' });
    expect(result.applied).toBe(false);
    expect(h.wrote).toHaveLength(0);
  });

  it('refuses without a serverUrl', () => {
    const h = harness({ projectId: PROJECT, teamId: JOINER_TEAM });
    expect(applyConvertJoin(h.deps, '/tmp/x', { ...join, serverUrl: '' }).applied).toBe(false);
  });
});
