// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'crypto';

// Deterministic content-idempotency key for manual record-intent writes. Both
// detection layers (agent + server-provider backstop) and any retry compute the
// SAME key for the same note, so the DB insert collapses them to one row.
// Content is normalized (trim, collapse whitespace, lowercase) so trivial
// re-phrasings of the identical note still dedup.
export function computeContentIdempotencyKey(input: {
  teamId: string;
  projectId: string;
  kind: string;
  content: string;
}): string {
  const normalized = input.content.trim().replace(/\s+/g, ' ').toLowerCase();
  const h = createHash('sha256')
    .update(`${input.teamId}${input.projectId}${input.kind}${normalized}`)
    .digest('hex');
  return `record-intent:v1:${h}`;
}
