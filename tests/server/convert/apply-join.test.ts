// SPDX-License-Identifier: Apache-2.0
//
// The client half of the Go Team convert. The server copies the data and hands
// back `join`; THIS applies it — writing the project's own marker and caching the
// team key in the local CredentialStore.
//
// It runs in the project's own process (the CLI/session hook), which is the only
// process that legitimately knows where that project lives. The server used to do
// this via flipToTeam(cwd, ...) using its OWN cwd, which meant converting one
// project would have flipped another's marker.
//
// The guard that matters: the marker at `cwd` must belong to the project named in
// the join. If they disagree we refuse — that mismatch IS the bug class this
// whole change exists to eliminate, so it must fail loudly rather than pick one.
import { describe, it, expect } from 'bun:test';
import { applyConvertJoin } from '../../../src/server/convert/apply-join.js';

const JOIN = {
  teamId: 'team-a',
  projectId: 'proj-a',
  serverUrl: 'http://team-a:38890',
  apiKey: 'cmem_teamkey',
};

function deps(markerProjectId: string | null, markerTeamId = 'team-a') {
  const calls = {
    runtime: [] as Array<{ cwd: string; runtime: string; serverUrl?: string; teamId?: string }>,
    keys: [] as Array<{ teamId: string; key: string }>,
  };
  return {
    calls,
    readProjectMarker: () => markerProjectId
      ? { projectId: markerProjectId, teamId: markerTeamId }
      : null,
    // teamId is recorded because a JOIN must write the NEW team into the marker;
    // dropping it here would let a stale-team regression pass unnoticed.
    writeProjectRuntime: (cwd: string, r: { runtime: 'local' | 'server'; serverUrl?: string; teamId?: string }) => {
      calls.runtime.push({ cwd, runtime: r.runtime, serverUrl: r.serverUrl, teamId: r.teamId });
    },
    storeKeyForTeam: (teamId: string, key: string) => { calls.keys.push({ teamId, key }); },
  };
}

describe('applyConvertJoin', () => {
  it('writes the marker and caches the key when the project matches', () => {
    const d = deps('proj-a');
    const r = applyConvertJoin(d, '/proj/a', JOIN);
    expect(r.applied).toBe(true);
    expect(d.calls.runtime).toEqual([
      // teamId is passed through even for convert, where it equals the marker's
      // existing team — writeProjectRuntime merges it, so this is a no-op here.
      { cwd: '/proj/a', runtime: 'server', serverUrl: 'http://team-a:38890', teamId: 'team-a' },
    ]);
    expect(d.calls.keys).toEqual([{ teamId: 'team-a', key: 'cmem_teamkey' }]);
  });

  it('REFUSES when the marker is a different project — writes nothing', () => {
    // Exactly the failure this design eliminates: applying project A's join to
    // project B's marker would point B at A's team server.
    const d = deps('proj-OTHER');
    const r = applyConvertJoin(d, '/proj/a', JOIN);
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('proj-OTHER');
    expect(d.calls.runtime).toEqual([]);
    expect(d.calls.keys).toEqual([]);
  });

  it('ALLOWS a differing marker team — that is what a JOIN is', () => {
    // This case previously asserted a REFUSAL, and that assertion was wrong once
    // /v1/join started sharing this function.
    //
    // The guard's documented intent (see the header above) is "the marker at cwd
    // must belong to the PROJECT named in the join". The team comparison rode
    // along because convert happens to preserve the team — it was never the
    // safety property. But a join moves a project into SOMEONE ELSE'S team, so
    // requiring the teams to match made every join fail: /v1/join returned 200
    // {"status":"joined"} while the marker never flipped, leaving the joiner on
    // the local runtime permanently (measured live against the rig).
    //
    // The cross-project protection is unchanged and still asserted by the
    // 'REFUSES when the marker is a different project' case above.
    const d = deps('proj-a', 'team-OTHER');
    const r = applyConvertJoin(d, '/proj/a', JOIN);
    expect(r.applied).toBe(true);
    // The marker must adopt the join's team, matching the team the key is cached
    // under — buildServerContext resolves the credential by marker.teamId, so a
    // stale team here means team mode with no resolvable key.
    expect(d.calls.runtime).toEqual([
      { cwd: '/proj/a', runtime: 'server', serverUrl: 'http://team-a:38890', teamId: 'team-a' },
    ]);
    expect(d.calls.keys).toEqual([{ teamId: 'team-a', key: 'cmem_teamkey' }]);
  });

  it('REFUSES when there is no marker at all rather than creating one', () => {
    // A convert must never mint an identity — that would fabricate a project.
    const d = deps(null);
    const r = applyConvertJoin(d, '/proj/a', JOIN);
    expect(r.applied).toBe(false);
    expect(d.calls.runtime).toEqual([]);
    expect(d.calls.keys).toEqual([]);
  });

  it('stores the key BEFORE the marker flip, so the flipped project is never keyless', () => {
    // Order is load-bearing: selectRuntime() follows the marker immediately, so a
    // marker written before the key exists leaves a window where the project
    // resolves to server mode with no credential (missing_api_key → dropped
    // observations, the "dark capture" regression).
    const order: string[] = [];
    const r = applyConvertJoin({
      readProjectMarker: () => ({ projectId: 'proj-a', teamId: 'team-a' }),
      writeProjectRuntime: () => { order.push('marker'); },
      storeKeyForTeam: () => { order.push('key'); },
    }, '/proj/a', JOIN);
    expect(r.applied).toBe(true);
    expect(order).toEqual(['key', 'marker']);
  });

  it('refuses a join with no apiKey rather than flipping to an unusable remote', () => {
    const d = deps('proj-a');
    const r = applyConvertJoin(d, '/proj/a', { ...JOIN, apiKey: '' });
    expect(r.applied).toBe(false);
    expect(d.calls.runtime).toEqual([]);
  });

  it('refuses a join with no serverUrl', () => {
    const d = deps('proj-a');
    const r = applyConvertJoin(d, '/proj/a', { ...JOIN, serverUrl: '' });
    expect(r.applied).toBe(false);
    expect(d.calls.runtime).toEqual([]);
  });

  it('does not flip the marker if caching the key throws', () => {
    // Fail closed: a project left on local with intact data is recoverable; one
    // flipped to a remote it cannot authenticate against is not.
    const d = {
      readProjectMarker: () => ({ projectId: 'proj-a', teamId: 'team-a' }),
      writeProjectRuntime: () => { throw new Error('should not be reached'); },
      storeKeyForTeam: () => { throw new Error('disk full'); },
    };
    expect(() => applyConvertJoin(d, '/proj/a', JOIN)).toThrow('disk full');
  });
});
