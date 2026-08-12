// tests/server/routes/v1/memories-quality-gate.test.ts
//
// Task 3 — quality gate moved from server-side generation to the ingest
// boundary (POST /v1/memories). See src/server/routes/v1/ingest-quality.ts.
//
// Two hazards this file exists to pin BEFORE the gate is wired into the route:
//   1. scoreObservation needs the STRUCTURED fields (facts/narrative/concepts),
//      which travel in `metadata`, not the flattened `content` string.
//   2. note_add (buildUserNoteRequest) posts { kind: 'user_note',
//      metadata: { userDirected: true } } with no facts/narrative/concepts —
//      it WILL score below the floor and must be exempted, but the exemption
//      must require BOTH conditions together, not just `kind`.

import { describe, it, expect } from 'bun:test';
import {
  scoreSubmittedObservation,
  meetsFloor,
  isExemptUserNote,
} from '../../../../src/server/routes/v1/ingest-quality.js';

const rich = {
  obsType: 'decision',
  facts: ['a', 'b', 'c'],
  narrative: 'A sufficiently long narrative explaining what was decided and why it matters.',
  title: 'A decision',
  concepts: ['x'],
};

describe('ingest quality scoring', () => {
  it('scores from the STRUCTURED fields, not the content string', () => {
    const score = scoreSubmittedObservation(rich);
    // eslint-disable-next-line no-console
    console.log('fixture=rich score=', score);
    expect(score).toBeGreaterThan(20);
  });

  it('scores a bare content-only submission BELOW the default floor', () => {
    const score = scoreSubmittedObservation({});
    // eslint-disable-next-line no-console
    console.log('fixture=empty score=', score);
    expect(score).toBeLessThan(20);
  });

  it('ignores a client-supplied quality value', () => {
    const spoofed = { ...rich, quality: 100 } as Record<string, unknown>;
    expect(scoreSubmittedObservation(spoofed)).toBe(scoreSubmittedObservation(rich));
  });

  it('meetsFloor is inclusive at the boundary', () => {
    expect(meetsFloor(20, 20)).toBe(true);
    expect(meetsFloor(19, 20)).toBe(false);
  });
});

describe('user_note exemption predicate (mandatory back-compat with note_add)', () => {
  it('the real note_add payload shape scores below the default floor of 20', () => {
    // Mirrors buildUserNoteRequest's produced metadata exactly: no facts, no
    // narrative, no concepts, no title, no obsType.
    const noteMetadata = { userDirected: true };
    const score = scoreSubmittedObservation(noteMetadata);
    // eslint-disable-next-line no-console
    console.log('fixture=note_add-shape score=', score);
    expect(score).toBeLessThan(20);
  });

  it('is exempt when kind=user_note AND metadata.userDirected=true (the note_add shape)', () => {
    expect(isExemptUserNote('user_note', { userDirected: true })).toBe(true);
  });

  it('is NOT exempt on kind alone — relabelling as user_note without userDirected must not bypass the bar', () => {
    expect(isExemptUserNote('user_note', {})).toBe(false);
    expect(isExemptUserNote('user_note', { userDirected: false })).toBe(false);
    expect(isExemptUserNote('user_note', undefined)).toBe(false);
  });

  it('is NOT exempt when userDirected=true is set on a non-user_note kind — the flag alone must not bypass the bar', () => {
    expect(isExemptUserNote('manual', { userDirected: true })).toBe(false);
    expect(isExemptUserNote(undefined, { userDirected: true })).toBe(false);
  });

  it('a low-quality NON-note submission (kind=manual, no userDirected) is not exempt', () => {
    expect(isExemptUserNote('manual', {})).toBe(false);
    const score = scoreSubmittedObservation({});
    expect(score).toBeLessThan(20);
  });
});
