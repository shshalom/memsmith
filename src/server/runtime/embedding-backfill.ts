// SPDX-License-Identifier: Apache-2.0
//
// Recover observations that were written without an embedding.
//
// embedForPersist degrades to NULL when the embedder is unavailable, which is
// the right trade: write correctness beats searchability, because losing the
// observation entirely would be far worse than losing its vector.
//
// But a NULL-embedding row is SEMANTICALLY DARK. It exists, keyword search finds
// it, and every semantic query misses it. To the user that is indistinguishable
// from the memory not being there at all.
//
// scripts/backfill-embeddings.ts repairs those rows — but a HUMAN HAS TO KNOW TO
// RUN IT. Same shape as the job drain: the recovery exists, nothing invokes it,
// and the damage accumulates in silence. Two dark rows sat unnoticed for two
// weeks and surfaced only during an audit.

export const DEFAULT_BACKFILL_BATCH = 200;

export interface EmbeddingBackfillQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface UnembeddedRow {
  id: string;
  content: string;
}

/**
 * Rows that exist but cannot be found semantically.
 *
 * NEWEST first: recent memory is the most likely to be recalled, so it is the
 * most valuable to make searchable again. Bounded so a large corpus cannot stall
 * startup. Never throws.
 */
export async function loadUnembeddedRows(
  pool: EmbeddingBackfillQueryable,
  opts: { limit?: number } = {},
): Promise<UnembeddedRow[]> {
  const limit = opts.limit ?? DEFAULT_BACKFILL_BATCH;
  try {
    const result = await pool.query(
      `SELECT id, content
         FROM observations
        WHERE embedding_vec IS NULL
          AND content IS NOT NULL
          AND length(trim(content)) > 0
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows
      .map(r => ({ id: String(r.id ?? ''), content: String(r.content ?? '') }))
      .filter(r => r.id && r.content.trim());
  } catch {
    return [];
  }
}

/**
 * How much of memory is actually searchable.
 *
 * Returns null when it cannot tell — reporting "0 dark" from a failed query
 * would be an unverified health claim, the same mistake the generation health
 * check exists to avoid.
 */
export async function countEmbeddingCoverage(
  pool: EmbeddingBackfillQueryable,
): Promise<{ total: number; embedded: number; dark: number } | null> {
  try {
    const result = await pool.query(
      `SELECT count(*) AS total, count(embedding_vec) AS embedded FROM observations`,
    );
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    const embedded = Number(row.embedded ?? 0);
    if (!Number.isFinite(total) || !Number.isFinite(embedded)) return null;
    return { total, embedded, dark: Math.max(0, total - embedded) };
  } catch {
    return null;
  }
}

export interface BackfillDeps {
  embed: (content: string) => Promise<number[] | null>;
  write: (id: string, vec: number[]) => Promise<void>;
}

/**
 * Embed and persist the given rows. Returns how many were repaired.
 *
 * A row that cannot be embedded is left dark for the next attempt rather than
 * marked done — the embedder may simply still be down. Never throws.
 */
export async function backfillEmbeddings(
  rows: UnembeddedRow[],
  deps: BackfillDeps,
): Promise<{ repaired: number; failed: number }> {
  let repaired = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const vec = await deps.embed(row.content);
      if (!vec) { failed += 1; continue; }
      await deps.write(row.id, vec);
      repaired += 1;
    } catch {
      failed += 1;
    }
  }
  return { repaired, failed };
}
