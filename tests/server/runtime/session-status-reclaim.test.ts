// SPDX-License-Identifier: Apache-2.0
//
// server_sessions.generation_status has transitions INTO 'processing'
// (server-sessions.ts:221) and out to 'completed' (:239) or 'failed' (:260) --
// but NO path back. A session whose process dies mid-generation stays
// 'processing' forever, with nothing to notice or recover it.
//
// This is the identical shape to the job stranding that reached 6,958 rows: a
// status a row can enter with no code path out of it. Zero sessions are stuck
// today, which is exactly how the job version started before it grew for two
// weeks in silence.
//
// The rule this encodes, and the one worth generalising: ANY status a row can
// enter must have a code path out of it.
import { describe, it, expect } from 'bun:test';
import {
  reclaimStaleSessionGeneration,
  DEFAULT_SESSION_STALE_MINUTES,
} from '../../../src/server/runtime/session-status-reclaim.js';

function fakePool(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

describe('reclaimStaleSessionGeneration', () => {
  it('returns a stranded processing session to idle', async () => {
    const pool = fakePool([{ id: 's1' }]);
    expect(await reclaimStaleSessionGeneration(pool as never)).toBe(1);
    const sql = pool.calls[0]!.text;
    expect(sql).toMatch(/UPDATE\s+server_sessions/i);
    expect(sql).toMatch(/generation_status\s*=\s*'idle'/i);
    expect(sql).toMatch(/generation_status\s*=\s*'processing'/i);
  });

  it('only reclaims sessions stale past the threshold — never one in flight', async () => {
    // Resetting a live session would let a second worker start the same
    // generation concurrently.
    const pool = fakePool([]);
    await reclaimStaleSessionGeneration(pool as never);
    expect(pool.calls[0]!.text).toMatch(/updated_at\s*<\s*now\(\)\s*-/i);
    expect(pool.calls[0]!.values).toContain(DEFAULT_SESSION_STALE_MINUTES);
  });

  it('honours an explicit threshold', async () => {
    const pool = fakePool([]);
    await reclaimStaleSessionGeneration(pool as never, { staleMinutes: 5 });
    expect(pool.calls[0]!.values).toContain(5);
  });

  it('never touches completed or failed sessions', async () => {
    // Those are terminal on purpose; only the stuck middle state is recovered.
    const pool = fakePool([]);
    await reclaimStaleSessionGeneration(pool as never);
    const sql = pool.calls[0]!.text;
    expect(sql).not.toMatch(/=\s*'completed'/i);
    expect(sql).not.toMatch(/=\s*'failed'/i);
  });

  it('never throws — this runs at startup', async () => {
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await reclaimStaleSessionGeneration(boom as never)).toBe(0);
  });

  it('reports zero when nothing is stranded', async () => {
    expect(await reclaimStaleSessionGeneration(fakePool([]) as never)).toBe(0);
  });
});
