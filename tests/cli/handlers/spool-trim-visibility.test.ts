// SPDX-License-Identifier: Apache-2.0
//
// Dropping captured work must never be silent.
//
// The spool is bounded at MAX_SPOOL_ENTRIES and trims the OLDEST entries when it
// overflows. Bounding it is right — an unbounded file on a laptop is the worse failure.
// But the drop was completely silent: no log, no counter, no signal anywhere. In TEAM
// mode this spool holds observations that have not reached the server yet
// (local-queue.ts wraps the same primitives), so a long offline stretch silently
// discards the user's oldest work and reports nothing.
//
// That is the "memory product that silently stops remembering" failure this codebase
// already names as its worst: the machinery looks fine the entire time it is losing data.
// Trimming stays; the silence does not.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spoolEvent, readSpooledEvents, MAX_SPOOL_ENTRIES } from '../../../src/cli/handlers/capture-spool.js';

let dir: string;
let spoolPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-spool-'));
  spoolPath = join(dir, 'spool.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `count` entries directly, bypassing the trim, to set up an overflow. */
function seed(count: number): void {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(JSON.stringify({ seq: i }));
  writeFileSync(spoolPath, `${lines.join('\n')}\n`, 'utf-8');
}

describe('spool trim visibility', () => {
  it('drops the OLDEST entries when it overflows, keeping the newest', () => {
    // Pins the existing, deliberate behaviour: recent context beats stale context.
    seed(MAX_SPOOL_ENTRIES + 500);
    spoolEvent(spoolPath, { seq: 'newest' });

    const kept = readSpooledEvents(spoolPath) as Array<{ seq: unknown }>;
    expect(kept.length).toBeLessThanOrEqual(MAX_SPOOL_ENTRIES + 1);
    // The newest survived; entry 0 did not.
    expect(kept[kept.length - 1]).toEqual({ seq: 'newest' });
    expect(kept.some(e => e.seq === 0)).toBe(false);
  });

  it('RECORDS how many entries were dropped, so the loss is discoverable', () => {
    // The regression this file exists for: the drop left no trace at all. A sidecar
    // counter next to the spool is enough — it survives process restarts, costs one
    // small write only when a trim actually happens, and gives the dashboard and any
    // future health check something concrete to read.
    seed(MAX_SPOOL_ENTRIES + 500);
    spoolEvent(spoolPath, { seq: 'newest' });

    const dropped = JSON.parse(readFileSync(`${spoolPath}.dropped.json`, 'utf-8')) as {
      droppedTotal: number; lastDroppedAt: string;
    };
    // 500 seeded overflow + the one just added, minus whatever slack the trim allows.
    expect(dropped.droppedTotal).toBeGreaterThan(0);
    expect(typeof dropped.lastDroppedAt).toBe('string');
  });

  it('writes no counter when nothing is dropped', () => {
    // A counter file that appears on every healthy run would be noise, and a
    // droppedTotal of 0 reads as "something happened" at a glance.
    spoolEvent(spoolPath, { seq: 1 });
    let exists = true;
    try { readFileSync(`${spoolPath}.dropped.json`, 'utf-8'); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('accumulates across separate trims rather than resetting', () => {
    // Two offline stretches must not hide the first one's loss.
    seed(MAX_SPOOL_ENTRIES + 500);
    spoolEvent(spoolPath, { seq: 'a' });
    const first = JSON.parse(readFileSync(`${spoolPath}.dropped.json`, 'utf-8')).droppedTotal as number;

    seed(MAX_SPOOL_ENTRIES + 500);
    spoolEvent(spoolPath, { seq: 'b' });
    const second = JSON.parse(readFileSync(`${spoolPath}.dropped.json`, 'utf-8')).droppedTotal as number;

    expect(second).toBeGreaterThan(first);
  });
});
