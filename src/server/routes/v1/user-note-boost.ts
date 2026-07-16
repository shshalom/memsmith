// SPDX-License-Identifier: Apache-2.0
import type { PostgresObservation } from '../../../storage/postgres/observations.js';

// Post-ranking reorder: float user-directed notes ahead of ambient observations
// WITHIN the already-relevant ranked set (never adds/removes rows). Stable —
// preserves relative order inside each group. strength<=0 is a no-op. This is
// "boost-within-relevant": a note irrelevant to the query is not in `ranked`, so
// it is never surfaced by this transform. Fail-safe: returns input on any issue.
export function boostUserDirected(ranked: PostgresObservation[], strength: number): PostgresObservation[] {
  if (!Array.isArray(ranked) || strength <= 0 || ranked.length < 2) return ranked;
  const notes: PostgresObservation[] = [];
  const rest: PostgresObservation[] = [];
  for (const o of ranked) (o.kind === 'user_note' ? notes : rest).push(o);
  if (notes.length === 0 || rest.length === 0) return ranked;
  return [...notes, ...rest];
}
