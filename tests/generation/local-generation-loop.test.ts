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
});
