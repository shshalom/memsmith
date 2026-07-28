// SPDX-License-Identifier: Apache-2.0
//
// Session-start claim of a pending Go Team join — the step that completes a
// convert. Runs in the project's own process, which is the only one that
// legitimately knows where the project lives.
//
// Everything here is fail-safe by construction: this runs on EVERY session start,
// so any failure must leave the project on local with its data intact and the note
// still pending, so the next session retries. A convert that never completes is
// recoverable; a session that cannot start is not.
import { describe, it, expect } from 'bun:test';
import { claimPendingTeamJoin, type ClaimDeps } from '../../../src/server/convert/claim-pending-join.js';
import { PENDING_JOIN_KEY } from '../../../src/server/convert/pending-join.js';

const CWD = '/proj/a';
const MARKER = { projectId: 'proj-a', teamId: 'team-a' };
const SERVER_URL = 'http://team-a:38890';

function deps(over: Partial<ClaimDeps> = {}): ClaimDeps & { applied: string[]; cleared: string[] } {
  const applied: string[] = [];
  const cleared: string[] = [];
  const base: ClaimDeps = {
    readProjectMarker: () => MARKER,
    resolveKeyForTeam: () => 'cmem_key',
    pool: {
      query: async (text: string) => {
        if (/SELECT metadata/i.test(text)) {
          return { rows: [{ metadata: { [PENDING_JOIN_KEY]: { teamId: 'team-a', serverUrl: SERVER_URL } } }] };
        }
        cleared.push('cleared');
        return { rows: [] };
      },
    },
    applyJoin: (_cwd, join) => { applied.push(join.serverUrl); return { applied: true }; },
    ...over,
  };
  return Object.assign(base, { applied, cleared });
}

describe('claimPendingTeamJoin', () => {
  it('applies a pending join and clears the note', async () => {
    const d = deps();
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(true);
    expect(d.applied).toEqual([SERVER_URL]);
    expect(d.cleared.length).toBeGreaterThan(0);
  });

  it('does nothing when the project has no marker', async () => {
    // Not a MemSmith project — nothing to claim, and we must never mint here.
    const d = deps({ readProjectMarker: () => null });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
    expect(d.applied).toEqual([]);
  });

  it('does nothing when the project is already in server mode', async () => {
    // Already converted: skip the remote round-trip entirely on every future
    // session start, rather than re-querying forever.
    const d = deps({ readProjectMarker: () => ({ ...MARKER, runtime: 'server' } as any) });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
    expect(d.applied).toEqual([]);
  });

  it('does nothing when no key is cached for the team', async () => {
    // Without a key there is no way to reach the destination, and flipping would
    // strand the project in server mode with no credential.
    const d = deps({ resolveKeyForTeam: () => null });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
    expect(d.applied).toEqual([]);
  });

  it('does nothing when there is no note waiting', async () => {
    const d = deps({ pool: { query: async () => ({ rows: [{ metadata: {} }] }) } });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
    expect(d.applied).toEqual([]);
  });

  it('does NOT clear the note when applying was refused', async () => {
    // applyConvertJoin refuses on a project mismatch. Keeping the note means the
    // mismatch stays visible instead of being silently swallowed.
    const d = deps({ applyJoin: () => ({ applied: false, reason: 'project mismatch' }) });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
    expect(d.cleared).toEqual([]);
  });

  it('never throws when the note query fails', async () => {
    // readPendingJoin is itself fail-safe, so this must surface as "no note"
    // rather than breaking session start.
    const d = deps({ pool: { query: async () => { throw new Error('db down'); } } });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
  });

  it('never throws when applying itself throws', async () => {
    const d = deps({ applyJoin: () => { throw new Error('disk full'); } });
    const r = await claimPendingTeamJoin(CWD, d);
    expect(r.applied).toBe(false);
  });

  it('does not clear the note when the note query fails', async () => {
    const d = deps({ pool: { query: async () => { throw new Error('boom'); } } });
    await claimPendingTeamJoin(CWD, d);
    expect(d.cleared).toEqual([]);
  });
});
