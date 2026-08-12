// SPDX-License-Identifier: Apache-2.0
//
// Quality scoring for client-submitted observations.
//
// Under local generation the client produces the observation, so the team's
// qualityFloor can no longer be enforced inside server-side generation
// (processGeneratedResponse.ts:128). It moves here, to the ingest boundary, so
// ONE team-wide bar applies no matter how many laptops submit.
//
// The score is always computed server-side. A client-supplied `quality` is
// ignored — trusting it would make the bar advisory.

import { scoreObservation } from '../../generation/quality.js';

/** Read the structured fields scoreObservation needs out of a submitted
 *  metadata bag. They live in metadata, NOT in the flattened content string —
 *  scoring content alone would score every submission near zero. */
export function scoreSubmittedObservation(metadata: Record<string, unknown>): number {
  return scoreObservation({
    obsType: typeof metadata.obsType === 'string' ? metadata.obsType : undefined,
    facts: Array.isArray(metadata.facts) ? (metadata.facts as string[]) : undefined,
    narrative: typeof metadata.narrative === 'string' ? metadata.narrative : undefined,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
    concepts: Array.isArray(metadata.concepts) ? (metadata.concepts as string[]) : undefined,
  });
}

/** Inclusive at the boundary, matching applyQualityGate's `quality < floor` drop. */
export function meetsFloor(score: number, floor: number): boolean {
  return score >= floor;
}

/**
 * The user-directed note carve-out — MANDATORY back-compat with note_add.
 *
 * buildUserNoteRequest (src/services/retrieval/user-note-write.ts) posts
 * { kind: 'user_note', metadata: { userDirected: true } } with no facts,
 * narrative, or concepts. That payload scores ~0 and would be rejected by the
 * floor, silently breaking the shipped "remember this" feature.
 *
 * Exempt ONLY when BOTH conditions hold together. A kind-only check would let
 * any client dodge the quality bar by relabelling its submission as
 * 'user_note'; requiring the paired flag keeps the exemption narrow to the
 * one deliberate, user-directed write path.
 */
export function isExemptUserNote(kind: string | undefined, metadata: Record<string, unknown> | undefined): boolean {
  return kind === 'user_note' && metadata?.userDirected === true;
}
