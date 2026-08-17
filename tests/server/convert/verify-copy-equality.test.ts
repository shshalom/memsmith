// SPDX-License-Identifier: Apache-2.0
//
// verifyCopy flagged only `remote < local`.
//
// With per-batch idempotency and no cross-batch transaction, a partially-applied retry
// can leave MORE rows on the destination than the source — and that passed verification
// while being wrong. Verification must mean "the same", not "at least as many": an
// over-copied project is not a verified project, and the flip to team mode is gated on
// this result.

import { describe, expect, it } from 'bun:test';
import { verifyCopy, COPY_TABLES } from '../../../src/server/convert/copy-engine.js';

function depsWith(local: number, remote: number) {
  return {
    readRows: async () => [],
    upsertRows: async () => {},
    countRows: async (which: 'local' | 'remote') => (which === 'local' ? local : remote),
  };
}

describe('verifyCopy', () => {
  it('passes when counts match', async () => {
    const r = await verifyCopy(depsWith(5, 5));
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('fails when the remote has FEWER rows', async () => {
    const r = await verifyCopy(depsWith(5, 3));
    expect(r.ok).toBe(false);
  });

  it('fails when the remote has MORE rows', async () => {
    // The regression: a duplicated retry inflates the destination, and treating "at
    // least as many" as success declared that copy verified.
    const r = await verifyCopy(depsWith(5, 7));
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ local: 5, remote: 7 });
  });

  it('reports every table that mismatches', async () => {
    const r = await verifyCopy(depsWith(1, 2));
    expect(r.mismatches).toHaveLength(COPY_TABLES.length);
  });
});
