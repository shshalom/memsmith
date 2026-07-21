// SPDX-License-Identifier: Apache-2.0
//
// Server-side backstop: strip <private> (and the other stripped tags) from
// every string value in an event payload BEFORE it is written to agent_events.
// This closes the ingest leak — private content must never be stored raw,
// even from a client that did not strip before transmit.

import { stripMemoryTags } from '../../utils/tag-stripping.js';

export function scrubEventPayload(payload: unknown): unknown {
  return scrubValue(payload);
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripMemoryTags(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}
