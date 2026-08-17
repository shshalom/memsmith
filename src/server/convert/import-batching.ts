// SPDX-License-Identifier: Apache-2.0
//
// Batching for the HTTPS import, bounded by BYTES rather than row count.
//
// runCopy batches at COPY_BATCH_SIZE (200) rows, which is the right unit for a direct
// connection issuing one INSERT per row. Over HTTPS the binding constraint is the
// server's JSON body limit — 5 MB (services/server/middleware.ts:9). An observations row
// carries content, a metadata JSONB blob and a 384-float embedding, several KB once
// serialised, so 200 rows can exceed the limit and 413. Row count cannot predict that;
// measured size can.
//
// The budget is an ESTIMATE, not a guarantee: the caller still handles 413 by halving,
// because only the server knows its own limit and headers ride on top of the body.

/**
 * Bytes of row payload per request.
 *
 * Deliberately well under the server's 5 MB limit: the JSON envelope (table name,
 * batchToken, field names) is sent on top of the rows, and a request that 413s costs a
 * full round trip to discover.
 */
export const IMPORT_BYTE_BUDGET = 3 * 1024 * 1024;

/**
 * Split rows into chunks whose serialised size stays within `budgetBytes`.
 *
 * Order is preserved — callers apply rows in sequence so that FK targets within a table
 * land before the rows referencing them, and the deferred-link pass depends on it.
 *
 * A single row larger than the budget is emitted alone: it cannot be split, and dropping
 * it would silently lose data. The caller's 413 handling is what covers that case.
 */
export function splitByByteBudget(
  rows: Array<Record<string, unknown>>,
  budgetBytes: number = IMPORT_BYTE_BUDGET,
): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let currentBytes = 0;

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
    // Flush BEFORE adding, so the row that would breach the budget starts the next
    // chunk rather than overflowing this one. An empty `current` never flushes, which
    // is precisely what lets an oversized row through alone instead of looping.
    if (current.length > 0 && currentBytes + size > budgetBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
