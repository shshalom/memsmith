// SPDX-License-Identifier: Apache-2.0
//
// TDD for drainGenerationQueue: drains the local generation queue (Task 1),
// generates each queued event (Task 4's generateOne), and POSTs the finished
// observation to the server. Every dependency is injected so this suite runs
// with no Ollama, no server, and no filesystem.

import { describe, it, expect } from 'bun:test';
import { drainGenerationQueue } from '../../src/services/generation/local-generation-loop.js';

describe('drainGenerationQueue', () => {
  it('generates each queued event and posts the finished observation', async () => {
    const posted: unknown[] = [];
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1', eventType: 'PostToolUse' }],
      clear: () => {},
      generate: async () => [{ type: 'decision', title: 'T', facts: ['f'], narrative: 'n' } as never],
      post: async (o: unknown) => { posted.push(o); },
    });
    expect(r.generated).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('KEEPS the event queued when generation throws (durability)', async () => {
    let cleared = false;
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => { cleared = true; },
      generate: async () => { throw new Error('ollama down'); },
      post: async () => {},
    });
    expect(r.failed).toBe(1);
    expect(cleared).toBe(false);
  });

  it('KEEPS the event queued when the POST fails', async () => {
    let cleared = false;
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => { cleared = true; },
      generate: async () => [{ type: 'x', title: 't' } as never],
      post: async () => { throw new Error('network'); },
    });
    expect(r.failed).toBe(1);
    expect(cleared).toBe(false);
  });

  it('CONSUMES an event the server rejects as below the quality floor', async () => {
    // 422 is a correct drop, not a retryable failure — requeuing would loop forever.
    let observedStatus: unknown;
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => {},
      generate: async () => [{ type: 'x', title: 't' } as never],
      post: async () => {
        const e = new Error('below floor') as Error & { status?: number };
        e.status = 422;
        observedStatus = e.status;
        throw e;
      },
    });
    // Prove the fixture can actually distinguish pass from fail: the loop
    // must have been handed a real status=422, not an error that merely
    // happens to be swallowed by a generic catch-all.
    console.log('observed status thrown by post():', observedStatus);
    expect(observedStatus).toBe(422);
    expect(r.failed).toBe(0);
    expect(r.generated).toBe(1);
  });

  it('is a no-op on an empty queue', async () => {
    const r = await drainGenerationQueue({ read: () => [], clear: () => {}, generate: async () => [], post: async () => {} });
    expect(r).toEqual({ generated: 0, failed: 0, kept: 0 });
  });

  it('partitions kept-vs-consumed: rewrites the queue with ONLY the still-failing entries', async () => {
    // Mixed batch: event A fails generation (must be kept), event B succeeds
    // (must be consumed). Proves partition-and-rewrite, not clear-all.
    let rewritten: unknown[] | null = null;
    const r = await drainGenerationQueue({
      read: () => [{ id: 'A', projectId: 'p1' }, { id: 'B', projectId: 'p1' }],
      clear: () => {},
      generate: async (event: unknown) => {
        const e = event as { id: string };
        if (e.id === 'A') throw new Error('ollama down');
        return [{ type: 'x', title: 't', facts: [], narrative: 'n' } as never];
      },
      post: async () => {},
      writeKept: (kept: unknown[]) => { rewritten = kept; },
    });
    expect(r.generated).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.kept).toBe(1);
    expect(rewritten).not.toBeNull();
    expect(rewritten).toHaveLength(1);
    expect((rewritten as unknown as Array<{ id: string }>)[0]!.id).toBe('A');
  });

  // REGRESSION GUARD — CAUGHT LIVE IN TASK 7 VALIDATION.
  //
  // Ollama returned an empty string, so generate() succeeded but produced ZERO
  // observations. The post loop (`for (const observation of observations)`)
  // therefore never ran, nothing was posted — and the event was still counted
  // as generated and DELETED from the queue. The work vanished with no error
  // and no trace, which is the exact failure class this project has fought
  // repeatedly (see the stranding-rule memory: any non-terminal state needs a
  // path out).
  //
  // An empty generation is NOT success. Keep the event queued so a transient
  // provider failure is retried rather than silently swallowed.
  it('KEEPS the event queued when generation returns ZERO observations', async () => {
    let cleared = false;
    let rewritten: unknown[] | null = null;
    const r = await drainGenerationQueue({
      read: () => [{ id: 'A', projectId: 'p1' }],
      clear: () => { cleared = true; },
      writeKept: (kept: unknown[]) => { rewritten = kept; },
      // Succeeds, but yields nothing — an empty provider response.
      generate: async () => [],
      post: async () => { throw new Error('post must never be called with zero observations'); },
    });
    expect(r.generated).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.kept).toBe(1);
    expect(cleared).toBe(false);
    expect(rewritten).toHaveLength(1);
  });

  // The complement: a real observation must still be consumed, so the guard
  // above cannot be satisfied by a blanket "never consume anything".
  it('still consumes an event that DID produce an observation', async () => {
    const posted: unknown[] = [];
    const r = await drainGenerationQueue({
      read: () => [{ id: 'A', projectId: 'p1' }],
      clear: () => {},
      generate: async () => [{ type: 'x', title: 't', facts: ['f'], narrative: 'n' } as never],
      post: async (o: unknown) => { posted.push(o); },
    });
    expect(r.generated).toBe(1);
    expect(r.failed).toBe(0);
    expect(posted).toHaveLength(1);
  });

  // A DELIBERATE skip must be CONSUMED, not retried. `<skip_summary />` is the
  // model saying "this event is not worth recording" (prompt-builder.ts:82).
  // Requeuing a considered "no" would loop forever on every trivial tool call —
  // the mirror-image bug of silently dropping a genuine fault.
  it('CONSUMES the event when generation deliberately skipped it', async () => {
    let cleared = false;
    let skipped = 0;
    const r = await drainGenerationQueue({
      read: () => [{ id: 'A', projectId: 'p1' }],
      clear: () => { cleared = true; },
      generate: async () => ({ observations: [], outcome: 'skipped' as const }),
      post: async () => { throw new Error('post must not be called for a skip'); },
      onSkippedGeneration: () => { skipped += 1; },
    });
    expect(r.failed).toBe(0);
    expect(r.kept).toBe(0);
    expect(cleared).toBe(true);
    expect(skipped).toBe(1);
  });

  // The same zero-length result with the OTHER outcome must be kept — proving
  // the loop branches on `outcome`, not on the array length.
  it('KEEPS the event when generation was unparseable, not skipped', async () => {
    let empty = 0;
    const r = await drainGenerationQueue({
      read: () => [{ id: 'A', projectId: 'p1' }],
      clear: () => {},
      writeKept: () => {},
      generate: async () => ({ observations: [], outcome: 'unparseable' as const }),
      post: async () => {},
      onEmptyGeneration: () => { empty += 1; },
    });
    expect(r.failed).toBe(1);
    expect(r.kept).toBe(1);
    expect(empty).toBe(1);
  });
});
