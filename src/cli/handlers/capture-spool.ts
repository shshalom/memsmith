// SPDX-License-Identifier: Apache-2.0
//
// Local durability for captured events the server could not accept.
//
// When the server is unreachable, observation.ts logged a fallback and returned
// `{ continue: true }` — the event was DROPPED. No queue row, no local copy,
// nothing to recover from. That moment of work never entered memory at all.
//
// This is upstream of every other recovery built today. The boot drain, the
// stale-lock reclaim, the transient reclaim and the continuous drain all recover
// work that REACHED Postgres; none of them can replay a row that was never
// written. Capture is the one path with no second chance.
//
// Not hypothetical: 3 events were dropped in a single day
// (reason=missing_api_key) during a server restart window.
//
// Format is JSONL — append-only, so concurrent hooks cannot clobber each other,
// and a half-written trailing line costs only that one event.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DATA_DIR } from '../../shared/paths.js';

/**
 * Cap on retained events.
 *
 * A server down for days must not grow an unbounded file on the user's disk.
 * When the cap is hit the OLDEST are dropped: recent context is more useful than
 * stale context, and the alternative — refusing new events — would silently
 * resume losing exactly what this exists to prevent.
 */
export const MAX_SPOOL_ENTRIES = 5_000;

/** Default spool location, alongside the rest of MemSmith's local state. */
export function defaultSpoolPath(): string {
  return join(DATA_DIR, 'capture-spool.jsonl');
}

/**
 * Persist an event that could not be delivered. Returns false on failure.
 *
 * NEVER throws: this runs inside a PostToolUse hook, and breaking the user's
 * tool call to record memory would be a far worse trade than losing one event.
 */
export function spoolEvent(path: string, event: unknown): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
    trimSpool(path);
    return true;
  } catch {
    return false;
  }
}

/** Read back everything spooled. Corrupt lines are skipped, never fatal. */
export function readSpooledEvents(path: string): unknown[] {
  try {
    if (!existsSync(path)) return [];
    const out: unknown[] = [];
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // A half-written line from a killed process must not cost the rest.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Remove the spool once its events are safely delivered. Never throws. */
export function clearSpool(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // Nothing to do — a spool that cannot be cleared is replayed next time, and
    // delivery is idempotent by source_id.
  }
}

/**
 * Keep the newest MAX_SPOOL_ENTRIES. Best-effort.
 *
 * Amortised: reading and rewriting the whole file on EVERY append is O(n^2) and
 * measurably stalls the hook once the spool is large (it timed out a 5s test at
 * 5,000 entries). Instead the check is cheap — a line count — and the rewrite
 * only happens when the cap is exceeded by a margin, so the expensive path runs
 * once per TRIM_SLACK appends rather than every time.
 */
export const TRIM_SLACK = 500;

/** Where the drop counter for a given spool lives. */
export function droppedCounterPath(spoolPath: string): string {
  return `${spoolPath}.dropped.json`;
}

/**
 * How much captured work this spool has discarded, or null when it has never dropped
 * any. Callers use it to surface the loss — a health indicator, the dashboard, a warning
 * on next connect.
 */
export function readDroppedCount(
  spoolPath: string,
): { droppedTotal: number; lastDroppedAt: string } | null {
  try {
    const raw = readFileSync(droppedCounterPath(spoolPath), 'utf-8');
    const parsed = JSON.parse(raw) as { droppedTotal?: unknown; lastDroppedAt?: unknown };
    const total = typeof parsed.droppedTotal === 'number' ? parsed.droppedTotal : 0;
    if (total <= 0) return null;
    return {
      droppedTotal: total,
      lastDroppedAt: typeof parsed.lastDroppedAt === 'string' ? parsed.lastDroppedAt : '',
    };
  } catch {
    // No counter file is the normal, healthy case — not an error.
    return null;
  }
}

/**
 * Accumulate a drop. ACCUMULATES rather than overwrites: two offline stretches must not
 * let the second hide the first. Best-effort — failing to record a drop must never break
 * capture, which is the thing actually worth protecting.
 */
function recordDropped(spoolPath: string, dropped: number): void {
  if (dropped <= 0) return;
  try {
    const previous = readDroppedCount(spoolPath)?.droppedTotal ?? 0;
    writeFileSync(
      droppedCounterPath(spoolPath),
      JSON.stringify({ droppedTotal: previous + dropped, lastDroppedAt: new Date().toISOString() }),
      'utf-8',
    );
  } catch {
    // Intentionally swallowed: see above.
  }
}

function trimSpool(path: string): void {
  try {
    // Cheap guard: count newlines rather than parsing every line.
    const raw = readFileSync(path, 'utf-8');
    let lines = 0;
    for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) === 10) lines += 1;
    if (lines <= MAX_SPOOL_ENTRIES + TRIM_SLACK) return;

    const events = readSpooledEvents(path);
    if (events.length <= MAX_SPOOL_ENTRIES) return;
    const kept = events.slice(events.length - MAX_SPOOL_ENTRIES);
    writeFileSync(path, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
    // RECORD THE LOSS. Trimming is correct — an unbounded file on a laptop is the worse
    // failure — but it was silent, and in TEAM mode this spool holds observations that
    // have not reached the server yet. A long offline stretch therefore discarded the
    // user's oldest work with no log, no counter and no signal anywhere: the machinery
    // looks healthy the whole time it is losing data, which is the exact failure mode
    // this project treats as its worst.
    //
    // A sidecar counter, not a log line: it survives restarts, is trivially readable by
    // a health check or the dashboard, and costs one small write only when a trim
    // actually happens.
    recordDropped(path, events.length - kept.length);
  } catch {
    // A trim failure is survivable; an unbounded file is the only real risk and
    // the next successful trim fixes it.
  }
}
