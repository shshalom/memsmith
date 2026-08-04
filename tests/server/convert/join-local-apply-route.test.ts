// SPDX-License-Identifier: Apache-2.0
//
// The UI contract for a join that succeeded remotely but not locally.
//
// summariseLocalApply is unit-tested in join-reports-local-apply.test.ts. What
// this file pins is the DECISION the dashboard makes from its output, because
// that decision is where the bug actually bit: JoinTeamModal treated
// `status === 'joined'` as unqualified success and called onJoined(), which
// closes the modal and reports done. A local apply that never happened was
// therefore indistinguishable from a complete join — while the project sat in
// team mode with no resolvable credential, silently dropping observations.
//
// The gate is extracted so it can be asserted without mounting React.
import { describe, it, expect } from 'bun:test';
import { summariseLocalApply } from '../../../src/server/convert/local-apply-report.js';

/**
 * Mirrors JoinTeamModal's branch: treat a 'joined' response as DONE only when
 * the local apply also happened.
 */
function joinIsComplete(body: { status?: string; localApplied?: false }): boolean {
  return body.status === 'joined' && body.localApplied !== false;
}

describe('join completeness, as the dashboard decides it', () => {
  it('a fully applied join is complete', () => {
    const body = { status: 'joined', ...summariseLocalApply({ applied: true }) };
    expect(joinIsComplete(body)).toBe(true);
  });

  it('a join whose marker was NOT flipped is NOT complete', () => {
    // THE REGRESSION GUARD. Before the fix this response was byte-identical to
    // the success case, so the modal closed and reported done.
    const body = {
      status: 'joined',
      ...summariseLocalApply({ applied: false, reason: 'no project marker at /tmp/x — nothing to flip' }),
    };
    expect(joinIsComplete(body)).toBe(false);
    expect(body.localReason).toContain('no project marker');
  });

  it('a join with no recorded project path is NOT complete', () => {
    // The fourth path: applyConvertJoin never even ran.
    const body = { status: 'joined', ...summariseLocalApply(null) };
    expect(joinIsComplete(body)).toBe(false);
  });

  it('status stays "joined" in every case — the team DID accept us', () => {
    // Downgrading to 'failed' would be wrong and would break the existing
    // contract: the remote row is committed, the key is valid, and a retry of
    // the whole join is not what the user needs. Only the local half is pending.
    for (const outcome of [{ applied: true }, { applied: false, reason: 'x' }, null]) {
      const body = { status: 'joined', ...summariseLocalApply(outcome) };
      expect(body.status).toBe('joined');
    }
  });

  it('a successful join carries NO new fields', () => {
    // Byte-identical to the pre-fix success response, so no client has to learn
    // a new field to understand an ordinary join.
    const body: Record<string, unknown> = { status: 'joined', ...summariseLocalApply({ applied: true }) };
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('an actual REMOTE failure is still a plain failure', () => {
    // summariseLocalApply is only consulted on the success path; a rejected key
    // must keep answering 422 with its specific reason, untouched.
    const body = { status: 'failed', error: 'that key has been revoked' };
    expect(joinIsComplete(body)).toBe(false);
    expect(body.error).toBe('that key has been revoked');
  });
});
