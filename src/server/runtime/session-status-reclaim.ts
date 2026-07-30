// SPDX-License-Identifier: Apache-2.0
//
// Recover sessions stranded mid-generation.
//
// server_sessions.generation_status has transitions INTO 'processing'
// (server-sessions.ts:221) and out to 'completed' (:239) or 'failed' (:260) --
// but no path back. A session whose process dies mid-generation stays
// 'processing' forever, with nothing to notice or recover it.
//
// Identical shape to the job stranding that reached 6,958 rows: a status a row
// can enter with no code path out of it. Zero sessions are stuck today, which is
// exactly how the job version started before it grew for two weeks in silence.
//
// THE GENERAL RULE, worth applying to any new status column: any status a row
// can enter must have a code path out of it.

/**
 * How long a session may sit in `processing` before it is presumed abandoned.
 *
 * Generous, matching the job lock reclaim: session-level generation can legitimately
 * take a while on a local model, and resetting a live session would let a second
 * worker start the same generation concurrently.
 */
export const DEFAULT_SESSION_STALE_MINUTES = 30;

export interface SessionReclaimQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Return sessions stuck in `processing` back to `idle` so they can be picked up
 * again. Never throws — this runs at startup.
 */
export async function reclaimStaleSessionGeneration(
  pool: SessionReclaimQueryable,
  opts: { staleMinutes?: number } = {},
): Promise<number> {
  const staleMinutes = opts.staleMinutes ?? DEFAULT_SESSION_STALE_MINUTES;
  try {
    const result = await pool.query(
      `UPDATE server_sessions
          SET generation_status = 'idle', updated_at = now()
        WHERE generation_status = 'processing'
          AND updated_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [staleMinutes],
    );
    return result.rows.length;
  } catch {
    return 0;
  }
}
