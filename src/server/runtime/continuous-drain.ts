// SPDX-License-Identifier: Apache-2.0
//
// Keep draining until the backlog is gone.
//
// The boot drain loads ONE batch of 500 and stops. On the dogfood's 6,917-job
// backlog that recovers 7% and then goes quiet — clearing the rest would take
// ~14 manual restarts. Measured live: once the batch drained, throughput fell to
// ~1.3/min and only 2 jobs completed in an hour, because the in-memory queue had
// run dry while 6,400 rows still sat in Postgres.
//
// The bounded batch itself was right (an unbounded SELECT on a large install is a
// memory risk). The missing half was refilling as it empties.
//
// Pacing matters as much as the loop. Handing a slow local model a 6,917-item
// work list would mean a shutdown strands all of it again — the original bug,
// reintroduced at a larger scale. So refill only when the queue is genuinely low.

/** Refill when the in-memory queue drops to this depth. */
export const DEFAULT_REFILL_THRESHOLD = 50;
/** Pause between polls when there is nothing to do. */
export const DEFAULT_POLL_MS = 5_000;
/** Consecutive failures tolerated before giving up on the loop. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface ContinuousDrainDeps {
  /** Load up to `limit` queued jobs into the queue; returns how many were loaded. */
  loadBatch: (limit: number) => Promise<number>;
  /** Current in-memory queue depth, so a slow model is not over-fed. */
  queueDepth: () => number;
  sleep: (ms: number) => Promise<void>;
  /** True once the service is shutting down. */
  isClosed: () => boolean;
  batchSize: number;
  refillThreshold?: number;
  pollMs?: number;
  /** Test seam / safety valve. */
  maxIterations?: number;
  onProgress?: (info: { loaded: number; totalLoaded: number }) => void;
}

/**
 * Drain the backlog in batches until it is exhausted or the service closes.
 *
 * Never throws: a refill failure must not kill the loop, because a dead loop
 * silently reinstates the exact bug this exists to fix. Repeated consecutive
 * failures do stop it, so a broken database is not polled forever.
 */
export async function runContinuousDrain(deps: ContinuousDrainDeps): Promise<void> {
  const threshold = deps.refillThreshold ?? DEFAULT_REFILL_THRESHOLD;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const maxIterations = deps.maxIterations ?? Number.MAX_SAFE_INTEGER;

  let totalLoaded = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < maxIterations; i += 1) {
    try {
      if (deps.isClosed()) return;

      // Only refill when the queue is actually low. Over-feeding a slow local
      // model means a shutdown strands the whole work list.
      if (deps.queueDepth() > threshold) {
        await deps.sleep(pollMs);
        continue;
      }

      const loaded = await deps.loadBatch(deps.batchSize);
      consecutiveFailures = 0;

      // Backlog exhausted — stop rather than spin on an empty table.
      if (loaded === 0) return;

      totalLoaded += loaded;
      deps.onProgress?.({ loaded, totalLoaded });

      if (deps.isClosed()) return;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
      try {
        await deps.sleep(pollMs);
      } catch {
        return; // even sleep is broken — stop cleanly
      }
    }
  }
}
