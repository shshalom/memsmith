// src/server/generation/embed-for-persist.ts
// SPDX-License-Identifier: Apache-2.0
import { logger } from '../../utils/logger.js';
import { embed } from './embedder.js';

// Embed observation content for semantic search on the persistence path.
// Best-effort: a failure returns null (the row persists without a vector; a
// later backfill can fill it) and NEVER throws — write correctness is
// paramount. Empty/blank content skips embedding. Shared by the generation
// pipeline (processGeneratedResponse) and the direct-insert route
// (/v1/memories) so both write paths embed identically.
//
// MUST be called OUTSIDE any DB transaction: a cold-start ONNX model load is
// multi-second and must not run while holding a pooled connection.
export async function embedForPersist(content: string): Promise<number[] | null> {
  const text = content.trim();
  if (!text) return null;
  try {
    return await embed(text);
  } catch (error) {
    logger.warn(
      'SYSTEM',
      'embedding failed; persisting observation without embedding_vec',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}
