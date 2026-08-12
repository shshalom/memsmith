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
