// SPDX-License-Identifier: Apache-2.0
//
// Periodic re-enqueue of generation retries whose backoff has elapsed, across
// the base database and every per-project database. Runs for the life of the
// server; the boot drain only covers what was queued at startup.

export const DEFAULT_RETRY_POLL_MS = 30_000;

export interface RetrySweepDeps<P> {
  /** Every pool to sweep, re-listed each pass so new projects are covered. */
  listPools: () => Promise<P[]>;
  /** Claim due retries in one pool and put them back on the queue; returns the count. */
  sweepPool: (pool: P) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  isClosed: () => boolean;
  pollMs?: number;
  /** Test seam. */
  maxPasses?: number;
  onRequeued?: (count: number) => void;
}

/** Never throws: a failed pass or pool is skipped and the next pass retries. */
export async function runRetrySweep<P>(deps: RetrySweepDeps<P>): Promise<void> {
  const pollMs = deps.pollMs ?? DEFAULT_RETRY_POLL_MS;
  const maxPasses = deps.maxPasses ?? Number.MAX_SAFE_INTEGER;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    try {
      await deps.sleep(pollMs);
    } catch {
      return;
    }
    if (deps.isClosed()) return;
    let pools: P[] = [];
    try { pools = await deps.listPools(); } catch { continue; }
    let requeued = 0;
    for (const pool of pools) {
      try { requeued += await deps.sweepPool(pool); } catch { /* next pool */ }
    }
    if (requeued > 0) deps.onRequeued?.(requeued);
  }
}
