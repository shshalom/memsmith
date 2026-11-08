// SPDX-License-Identifier: Apache-2.0
//
// Server-side backstop: strip <private> (and the other stripped tags) and
// redact secrets in every string value of an event payload BEFORE it is
// written to agent_events. Private content and secrets must never be stored
// raw, even from a client that did not scrub before transmit.

import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { redactSecretsDeep } from '../../shared/secret-redaction.js';

export function scrubEventPayload(payload: unknown): unknown {
  return redactSecretsDeep(scrubValue(payload));
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
