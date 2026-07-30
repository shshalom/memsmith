// SPDX-License-Identifier: Apache-2.0
//
// THE HOLE THIS CLOSES — and it is upstream of every other fix made today.
//
// When the server is unreachable, observation.ts logs a fallback and returns
// `{ continue: true }`. The event is DROPPED. There is no queue row, no local
// copy, nothing to recover from: that moment of work never enters memory at all.
//
// Every recovery built so far (boot drain, stale-lock reclaim, transient
// reclaim, continuous drain) recovers work that REACHED Postgres. This is work
// that never got there. A drain cannot replay a row that was never written.
//
// It is not hypothetical: 3 events were dropped today with
// reason=missing_api_key, during the window when the server was restarting.
// Each is a permanently missing piece of the user's memory.
//
// The spool is a local append-only file: capture writes there when the server
// cannot be reached, and a later session flushes it. Capture is the one path
// that must never lose data, because it is the only one with no second chance.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  spoolEvent,
  readSpooledEvents,
  clearSpool,
  MAX_SPOOL_ENTRIES,
  TRIM_SLACK,
} from '../../../src/cli/handlers/capture-spool.js';

function tmp() {
  return join(mkdtempSync(join(tmpdir(), 'memsmith-spool-')), 'spool.jsonl');
}

const EVENT = { projectId: 'p1', eventType: 'tool_use', payload: { tool_name: 'Read' } };

describe('spoolEvent', () => {
  it('persists an event the server could not accept', () => {
    const p = tmp();
    try {
      expect(spoolEvent(p, EVENT)).toBe(true);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf-8')).toContain('tool_use');
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('APPENDS rather than overwriting — concurrent hooks must not clobber', () => {
    // Several hooks can fire in the same window while the server is down.
    const p = tmp();
    try {
      spoolEvent(p, { ...EVENT, seq: 1 });
      spoolEvent(p, { ...EVENT, seq: 2 });
      spoolEvent(p, { ...EVENT, seq: 3 });
      expect(readSpooledEvents(p)).toHaveLength(3);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('never throws — a spool failure must not break the user\'s tool call', () => {
    // This runs inside a PostToolUse hook. Breaking the user's workflow to
    // record memory would be a far worse trade than losing one event.
    expect(spoolEvent('/nonexistent-dir-xyz/spool.jsonl', EVENT)).toBe(false);
  });

  it('bounds the spool so an extended outage cannot fill the disk', () => {
    // A server down for days must not grow an unbounded file. Trimming is
    // AMORTISED (see TRIM_SLACK): rewriting on every append is O(n^2) and stalls
    // the hook, so the file may briefly exceed the cap before being cut back.
    // What must hold is that it stays bounded and keeps the NEWEST events.
    const p = tmp();
    const total = MAX_SPOOL_ENTRIES + TRIM_SLACK + 10;
    try {
      for (let i = 0; i < total; i += 1) spoolEvent(p, { ...EVENT, seq: i });
      const kept = readSpooledEvents(p);
      expect(kept.length).toBeLessThanOrEqual(MAX_SPOOL_ENTRIES + TRIM_SLACK);
      // Recent context is more useful than stale context.
      expect((kept[kept.length - 1] as { seq: number }).seq).toBe(total - 1);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

describe('readSpooledEvents', () => {
  it('returns an empty list when there is no spool', () => {
    expect(readSpooledEvents('/nonexistent-xyz/spool.jsonl')).toEqual([]);
  });

  it('skips a corrupt line instead of losing the whole spool', () => {
    // A half-written line from a killed process must not cost the other events.
    const p = tmp();
    try {
      writeFileSync(p, `${JSON.stringify(EVENT)}\n{not json\n${JSON.stringify(EVENT)}\n`, 'utf-8');
      expect(readSpooledEvents(p)).toHaveLength(2);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('tolerates a trailing partial line', () => {
    const p = tmp();
    try {
      writeFileSync(p, `${JSON.stringify(EVENT)}\n{"partial":`, 'utf-8');
      expect(readSpooledEvents(p)).toHaveLength(1);
    } finally {
      rmSync(p, { force: true });
    }
  });
});

describe('clearSpool', () => {
  it('removes the spool once its events are safely delivered', () => {
    const p = tmp();
    try {
      spoolEvent(p, EVENT);
      clearSpool(p);
      expect(readSpooledEvents(p)).toEqual([]);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('never throws when there is nothing to clear', () => {
    clearSpool('/nonexistent-xyz/spool.jsonl');
  });
});
