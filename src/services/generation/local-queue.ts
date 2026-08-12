// SPDX-License-Identifier: Apache-2.0
//
// The team-mode generation queue: events awaiting LOCAL generation.
//
// Reuses capture-spool's primitives (bounded at MAX_SPOOL_ENTRIES, trimmed,
// corrupt-file tolerant, never throws) but against its OWN file. The two
// queues are drained with OPPOSITE semantics — the capture spool forwards raw
// events to the server, this one generates first and posts the finished
// observation. Sharing one file would eventually ship raw events unprocessed.

import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { spoolEvent, readSpooledEvents, clearSpool, defaultSpoolPath } from '../../cli/handlers/capture-spool.js';

export function generationQueuePath(): string {
  return join(dirname(defaultSpoolPath()), 'generation-queue.jsonl');
}

export function enqueueForGeneration(event: unknown, path: string = generationQueuePath()): boolean {
  return spoolEvent(path, event);
}

export function readGenerationQueue(path: string = generationQueuePath()): unknown[] {
  return readSpooledEvents(path);
}

export function clearGenerationQueue(path: string = generationQueuePath()): void {
  clearSpool(path);
}

/**
 * Rewrite the queue file to contain EXACTLY `events` — used by the drain loop
 * to partition kept-vs-consumed after a pass (Task 5). An empty array removes
 * the file entirely (mirrors clearGenerationQueue) rather than leaving a
 * lone trailing newline, so "nothing left" reads back as `[]` via
 * readGenerationQueue's existsSync guard either way.
 *
 * Never throws: this is queue bookkeeping, not the caller's critical path —
 * a failed rewrite means the next drain re-reads the pre-rewrite file and
 * simply reprocesses (generation is idempotent-safe by design; duplicate
 * posts are the concern the 422 quality gate does not solve, but that
 * tradeoff belongs to the drain loop, not this primitive).
 */
export function writeGenerationQueue(events: unknown[], path: string = generationQueuePath()): void {
  try {
    if (events.length === 0) {
      clearSpool(path);
      return;
    }
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${events.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  } catch {
    // Best-effort; see doc comment above.
  }
}
