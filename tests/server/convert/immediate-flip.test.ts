// SPDX-License-Identifier: Apache-2.0
//
// The convert now completes the flip immediately instead of deferring it to the
// project's next session.
//
// WHY THE DEFERRAL WAS WRONG: reading the marker needs no restart — verified live
// by flipping server->local->server inside one running process, with every
// selectRuntime call following the file. Having proven that, deferring the WRITE
// to session start reintroduced exactly the wait the proof had just removed. The
// user caught the contradiction; it was a design mistake, not a code one.
//
// WHY THIS IS NOT A RETURN OF THE BUG: the server writing a marker is only unsafe
// when it has to GUESS which directory. It no longer guesses — the path comes from
// the authenticated project's own database row, and applyConvertJoin independently
// refuses when the marker at that path belongs to a different project. Two
// independent checks, neither of them the server's cwd.
import { describe, it, expect } from 'bun:test';
import { applyConvertJoin } from '../../../src/server/convert/apply-join.js';
import { PROJECT_PATH_KEY } from '../../../src/services/identity/project-identity.js';

const TEMP = '42d7997d-5708-4e26-9e7c-b6f2247085a8';
const DOGFOOD = '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const TEAM = 'bfc62ef3-81f5-4b9e-a904-9456013605f9';

// Mirrors the route's resolution: read the path from the project's own row, then
// hand it to applyConvertJoin.
function flipVia(
  projectRow: { metadata: Record<string, unknown> | null },
  markers: Record<string, { projectId: string; teamId: string }>,
) {
  const writes: Array<{ cwd: string; runtime: string }> = [];
  const keys: Array<{ teamId: string }> = [];
  const path = projectRow.metadata?.[PROJECT_PATH_KEY];
  if (typeof path !== 'string' || !path.trim()) {
    return { attempted: false, writes, keys, result: null };
  }
  const result = applyConvertJoin(
    {
      readProjectMarker: (c) => markers[c] ?? null,
      writeProjectRuntime: (cwd, r) => { writes.push({ cwd, runtime: r.runtime }); },
      storeKeyForTeam: (teamId) => { keys.push({ teamId }); },
    },
    path,
    { teamId: TEAM, projectId: TEMP, serverUrl: 'http://127.0.0.1:38879', apiKey: 'cmem_k' },
  );
  return { attempted: true, writes, keys, result };
}

describe('immediate flip after a successful convert', () => {
  it('flips the project at its RECORDED path', async () => {
    const out = flipVia(
      { metadata: { [PROJECT_PATH_KEY]: '/private/tmp/ms-p3-fresh' } },
      { '/private/tmp/ms-p3-fresh': { projectId: TEMP, teamId: TEAM } },
    );
    expect(out.result?.applied).toBe(true);
    expect(out.writes).toEqual([{ cwd: '/private/tmp/ms-p3-fresh', runtime: 'server' }]);
  });

  it('REGRESSION: refuses when the recorded path holds ANOTHER project\'s marker', () => {
    // The bug this whole redesign exists to prevent: flipping the dogfood's
    // marker while converting the temp project. A stale or reused directory must
    // not be trusted just because it was once recorded.
    const out = flipVia(
      { metadata: { [PROJECT_PATH_KEY]: '/Users/x/MemSmith' } },
      { '/Users/x/MemSmith': { projectId: DOGFOOD, teamId: 'other-team' } },
    );
    expect(out.result?.applied).toBe(false);
    expect(out.writes).toEqual([]);
    expect(out.keys).toEqual([]);
  });

  it('does not attempt a flip when no path was ever recorded', () => {
    // Projects minted before path recording. The pending note remains, so their
    // next session finishes the job — no guessing from the server's cwd.
    const out = flipVia({ metadata: {} }, {});
    expect(out.attempted).toBe(false);
    expect(out.writes).toEqual([]);
  });

  it('does not attempt a flip when the metadata is absent entirely', () => {
    const out = flipVia({ metadata: null }, {});
    expect(out.attempted).toBe(false);
  });

  it('refuses when the recorded path has no marker at all', () => {
    // Directory deleted or moved since it was recorded.
    const out = flipVia({ metadata: { [PROJECT_PATH_KEY]: '/gone' } }, {});
    expect(out.result?.applied).toBe(false);
    expect(out.writes).toEqual([]);
  });

  it('writes the key before the marker so the flipped project is never keyless', () => {
    // selectRuntime follows the marker on its next call, so a marker written
    // first would leave a window in server mode with no credential.
    const order: string[] = [];
    applyConvertJoin(
      {
        readProjectMarker: () => ({ projectId: TEMP, teamId: TEAM }),
        writeProjectRuntime: () => { order.push('marker'); },
        storeKeyForTeam: () => { order.push('key'); },
      },
      '/p/a',
      { teamId: TEAM, projectId: TEMP, serverUrl: 'http://x', apiKey: 'cmem_k' },
    );
    expect(order).toEqual(['key', 'marker']);
  });
});
