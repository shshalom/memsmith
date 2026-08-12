import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { enqueueForGeneration, readGenerationQueue, clearGenerationQueue, generationQueuePath } from '../../src/services/generation/local-queue.js';
import { defaultSpoolPath } from '../../src/cli/handlers/capture-spool.js';

let dir: string; let p: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-gq-')); p = join(dir, 'q.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('local generation queue', () => {
  it('round-trips an enqueued event', () => {
    enqueueForGeneration({ eventType: 'PostToolUse', projectId: 'p1' }, p);
    const got = readGenerationQueue(p) as Array<Record<string, unknown>>;
    expect(got).toHaveLength(1);
    expect(got[0]!.projectId).toBe('p1');
  });

  it('appends rather than overwriting', () => {
    enqueueForGeneration({ n: 1 }, p);
    enqueueForGeneration({ n: 2 }, p);
    expect(readGenerationQueue(p)).toHaveLength(2);
  });

  it('clears', () => {
    enqueueForGeneration({ n: 1 }, p);
    clearGenerationQueue(p);
    expect(readGenerationQueue(p)).toHaveLength(0);
  });

  it('returns empty for a missing file, never throws', () => {
    expect(readGenerationQueue(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('never throws when the path is unwritable', () => {
    expect(() => enqueueForGeneration({ n: 1 }, '/proc/nope/q.jsonl')).not.toThrow();
  });

  // The whole point of a separate file.
  it('uses a DIFFERENT default path than the capture spool', () => {
    expect(generationQueuePath()).not.toBe(defaultSpoolPath());
  });
});
