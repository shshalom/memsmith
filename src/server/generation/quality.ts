// SPDX-License-Identifier: Apache-2.0
// Adapted from agentmemory/src/eval/quality.ts (Apache-2.0) — scoreCompression,
// with a small type bonus for high-signal observation kinds.

const HIGH_SIGNAL_TYPES = new Set(['decision', 'gotcha', 'blocker']);

export function scoreObservation(obs: {
  obsType?: string;
  facts?: string[];
  narrative?: string;
  title?: string;
  concepts?: string[];
}): number {
  let score = 0;
  if (obs.facts && obs.facts.length > 0) score += 25;
  if (obs.facts && obs.facts.length >= 3) score += 10;
  if (obs.narrative && obs.narrative.length >= 20) score += 20;
  if (obs.narrative && obs.narrative.length >= 50) score += 5;
  if (obs.title && obs.title.length >= 5 && obs.title.length <= 120) score += 15;
  if (obs.concepts && obs.concepts.length > 0) score += 15;
  if (obs.obsType && HIGH_SIGNAL_TYPES.has(obs.obsType)) score += 10;
  return Math.min(100, score);
}
