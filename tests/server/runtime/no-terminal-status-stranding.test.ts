// SPDX-License-Identifier: Apache-2.0
//
// THE RULE, extracted from three separate incidents in one day:
//
//   ANY non-terminal status a row can enter MUST have a code path out of it.
//
// Violating it strands work silently and indefinitely. It happened three times:
//   - observation_generation_jobs 'queued'     -> 6,958 rows over two weeks
//   - observation_generation_jobs 'processing' -> 11 rows locked by dead workers
//   - server_sessions 'processing'             -> latent, 0 rows, caught before it grew
//
// Each was invisible: no error, no warning, the machinery looked healthy. The
// job version reached nearly seven thousand rows before anyone noticed.
//
// A one-off audit cannot prevent the next one, because the next one arrives with
// the next status column somebody adds. This test is the durable form of that
// audit: it fails if a recovery path is removed, so the rule is enforced rather
// than remembered.
import { describe, it, expect } from 'bun:test';
import {
  reclaimStaleLocks,
  reclaimTransientFailures,
} from '../../../src/server/runtime/generation-drain.js';
import { reclaimStaleSessionGeneration } from '../../../src/server/runtime/session-status-reclaim.js';

function capturingPool() {
  const calls: string[] = [];
  return {
    calls,
    query: async (text: string) => { calls.push(text); return { rows: [] }; },
  };
}

/** Every non-terminal status, and the function that must be able to recover it. */
const RECOVERABLE = [
  {
    what: "observation_generation_jobs 'processing' (worker died holding the lock)",
    run: (p: unknown) => reclaimStaleLocks(p as never),
    from: /status\s*=\s*'processing'/i,
    to: /status\s*=\s*'queued'/i,
  },
  {
    what: "observation_generation_jobs 'failed' but transient (provider blip)",
    run: (p: unknown) => reclaimTransientFailures(p as never),
    from: /status\s*=\s*'failed'/i,
    to: /status\s*=\s*'queued'/i,
  },
  {
    what: "server_sessions 'processing' (process died mid-generation)",
    run: (p: unknown) => reclaimStaleSessionGeneration(p as never),
    from: /generation_status\s*=\s*'processing'/i,
    to: /generation_status\s*=\s*'idle'/i,
  },
];

describe('no status may strand work without a recovery path', () => {
  for (const c of RECOVERABLE) {
    it(`recovers: ${c.what}`, async () => {
      const pool = capturingPool();
      await c.run(pool);
      const sql = pool.calls.join('\n');
      expect(sql).toMatch(c.from);   // it targets the stuck state
      expect(sql).toMatch(c.to);     // and moves it somewhere runnable
    });
  }

  it('every recovery is time-bounded, never resetting live work', async () => {
    // Recovering a job or session that is genuinely in flight would run the same
    // work twice concurrently. Each reclaim must gate on staleness.
    for (const c of RECOVERABLE) {
      const pool = capturingPool();
      await c.run(pool);
      expect(pool.calls.join('\n')).toMatch(/<\s*now\(\)\s*-/i);
    }
  });

  it('every recovery fails safe rather than breaking startup', async () => {
    // These all run at boot. A recovery that throws would stop the server.
    const boom = { query: async () => { throw new Error('pg down'); } };
    for (const c of RECOVERABLE) {
      expect(await c.run(boom)).toBe(0);
    }
  });
});
