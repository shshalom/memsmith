// SPDX-License-Identifier: Apache-2.0

// Char->token estimate. Consistent with other rough token estimates in the
// codebase (~4 chars/token). Documented as an estimate, not a tokenizer.
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface CompressionEvent {
  teamId: string;
  projectId: string | null;
  kind: 'compression';
  quantity: number;
  metadata: { preTokens: number; postTokens: number; tier: string };
}

export function buildCompressionEvent(
  teamId: string,
  projectId: string | null,
  preChars: number,
  postChars: number,
  tier: string,
): CompressionEvent {
  const preTokens = estimateTokens(preChars);
  const postTokens = estimateTokens(postChars);
  return {
    teamId,
    projectId,
    kind: 'compression',
    quantity: Math.max(0, preTokens - postTokens),
    metadata: { preTokens, postTokens, tier },
  };
}
