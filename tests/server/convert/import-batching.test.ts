// SPDX-License-Identifier: Apache-2.0
//
// Row count is the wrong bound for an HTTPS import.
//
// COPY_BATCH_SIZE is 200 (copy-engine.ts:27), which is right for a direct connection
// issuing one INSERT per row. Over HTTPS the binding constraint is the server's JSON
// body limit — 5 MB (services/server/middleware.ts:9). An observations row carries
// content, a metadata JSONB blob and a 384-float embedding, several KB once serialised,
// so 200 rows can exceed the limit and return 413. Row count cannot predict that;
// measured size can.

import { describe, expect, it } from 'bun:test';
import { splitByByteBudget, IMPORT_BYTE_BUDGET } from '../../../src/server/convert/import-batching.js';

describe('splitByByteBudget', () => {
  it('keeps a small set in one chunk', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    expect(splitByByteBudget(rows, 10_000)).toEqual([rows]);
  });

  it('splits when the budget is exceeded', () => {
    const big = { content: 'x'.repeat(400) };
    const chunks = splitByByteBudget([big, big, big], 900);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(3);
  });

  it('never drops or reorders rows', () => {
    // Order is load-bearing: callers apply rows in sequence for FK safety within a
    // table, so a splitter that reordered would break the deferred-link pass.
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'y'.repeat(100) }));
    const chunks = splitByByteBudget(rows, 1_000);
    expect(chunks.flat().map((r: Record<string, unknown>) => r.i)).toEqual(rows.map(r => r.i));
  });

  it('emits an oversized row alone rather than dropping it or looping forever', () => {
    // A single row bigger than the whole budget cannot be split. It must still be
    // attempted: dropping it loses data silently, and skipping it spins.
    const huge = { content: 'z'.repeat(5_000) };
    const chunks = splitByByteBudget([huge, { a: 1 }], 1_000);
    expect(chunks[0]).toEqual([huge]);
    expect(chunks.flat()).toHaveLength(2);
  });

  it('returns no chunks for no rows', () => {
    expect(splitByByteBudget([], 1_000)).toEqual([]);
  });

  it('leaves headroom under the 5 MB server limit', () => {
    // The budget must sit BELOW the limit, not at it: the JSON envelope (table name,
    // batchToken, field names) is sent on top of the row payload.
    expect(IMPORT_BYTE_BUDGET).toBeLessThan(5 * 1024 * 1024);
  });
});
