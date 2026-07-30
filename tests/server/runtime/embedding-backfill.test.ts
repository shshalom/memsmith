// SPDX-License-Identifier: Apache-2.0
//
// embedForPersist degrades to NULL when the embedder is unavailable — correct,
// because write correctness must beat searchability: losing the observation
// would be far worse than losing its vector.
//
// But a NULL-embedding row is SEMANTICALLY DARK. It exists, it is returned by
// keyword search, and it is invisible to every semantic query. To the user that
// is indistinguishable from the memory not being there — the exact failure this
// product exists to prevent.
//
// scripts/backfill-embeddings.ts fixes those rows, but a HUMAN HAS TO KNOW TO
// RUN IT. That is the same shape as the job drain: recovery exists, nothing
// invokes it, and the damage accumulates silently. Two dark rows sat unnoticed
// for two weeks and were only found by an audit.
//
// So: backfill on boot, and report coverage so a gap is visible rather than
// discovered.
import { describe, it, expect } from 'bun:test';
import {
  loadUnembeddedRows,
  countEmbeddingCoverage,
  DEFAULT_BACKFILL_BATCH,
} from '../../../src/server/runtime/embedding-backfill.js';

function fakePool(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows };
    },
  };
}

describe('loadUnembeddedRows', () => {
  it('finds rows that exist but are semantically invisible', async () => {
    const pool = fakePool([{ id: 'o1', content: 'a decision' }]);
    const rows = await loadUnembeddedRows(pool as never);
    expect(rows).toEqual([{ id: 'o1', content: 'a decision' }]);
    expect(pool.calls[0]!.text).toMatch(/embedding_vec\s+IS\s+NULL/i);
  });

  it('skips rows with no content — there is nothing to embed', async () => {
    const pool = fakePool([]);
    await loadUnembeddedRows(pool as never);
    expect(pool.calls[0]!.text).toMatch(/content\s+IS\s+NOT\s+NULL/i);
  });

  it('is bounded so a large corpus cannot stall boot', async () => {
    const pool = fakePool([]);
    await loadUnembeddedRows(pool as never);
    expect(pool.calls[0]!.text).toMatch(/LIMIT/i);
    expect(pool.calls[0]!.values).toContain(DEFAULT_BACKFILL_BATCH);
  });

  it('takes the NEWEST first — recent memory is the most likely to be recalled', async () => {
    const pool = fakePool([]);
    await loadUnembeddedRows(pool as never);
    expect(pool.calls[0]!.text).toMatch(/ORDER BY\s+created_at\s+DESC/i);
  });

  it('never throws — a backfill failure must not stop startup', async () => {
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await loadUnembeddedRows(boom as never)).toEqual([]);
  });
});

import { backfillEmbeddings } from '../../../src/server/runtime/embedding-backfill.js';

describe('backfillEmbeddings', () => {
  const ROWS = [{ id: 'a', content: 'one' }, { id: 'b', content: 'two' }];

  it('embeds and persists each dark row', async () => {
    const written: string[] = [];
    const r = await backfillEmbeddings(ROWS, {
      embed: async () => [0.1, 0.2],
      write: async (id: string) => { written.push(id); },
    });
    expect(r).toEqual({ repaired: 2, failed: 0 });
    expect(written).toEqual(['a', 'b']);
  });

  it('LEAVES a row dark when the embedder is still down, rather than marking it done', async () => {
    // Writing a placeholder or skipping permanently would make the row look
    // repaired while remaining unsearchable — worse than leaving it for retry.
    const written: string[] = [];
    const r = await backfillEmbeddings(ROWS, {
      embed: async () => null,
      write: async (id: string) => { written.push(id); },
    });
    expect(r).toEqual({ repaired: 0, failed: 2 });
    expect(written).toEqual([]);
  });

  it('one failure does not abort the rest of the batch', async () => {
    let n = 0;
    const r = await backfillEmbeddings(ROWS, {
      embed: async () => { n += 1; if (n === 1) throw new Error('embedder blip'); return [0.1]; },
      write: async () => {},
    });
    expect(r).toEqual({ repaired: 1, failed: 1 });
  });

  it('never throws when the write fails', async () => {
    const r = await backfillEmbeddings(ROWS, {
      embed: async () => [0.1],
      write: async () => { throw new Error('pg down'); },
    });
    expect(r.repaired).toBe(0);
  });

  it('handles an empty batch', async () => {
    expect(await backfillEmbeddings([], { embed: async () => [0.1], write: async () => {} }))
      .toEqual({ repaired: 0, failed: 0 });
  });
});

describe('countEmbeddingCoverage', () => {
  it('reports how much of memory is actually searchable', async () => {
    const pool = fakePool([{ total: '100', embedded: '98' }]);
    expect(await countEmbeddingCoverage(pool as never)).toEqual({
      total: 100, embedded: 98, dark: 2,
    });
  });

  it('reports full coverage as zero dark rows', async () => {
    const pool = fakePool([{ total: '4928', embedded: '4928' }]);
    expect(await countEmbeddingCoverage(pool as never)).toEqual({
      total: 4928, embedded: 4928, dark: 0,
    });
  });

  it('handles an empty corpus without dividing by zero', async () => {
    const pool = fakePool([{ total: '0', embedded: '0' }]);
    expect(await countEmbeddingCoverage(pool as never)).toEqual({
      total: 0, embedded: 0, dark: 0,
    });
  });

  it('returns null rather than a fake number when it cannot tell', async () => {
    // Reporting "0 dark" from a failed query would be an unverified health
    // claim — the precise mistake the generation health check exists to avoid.
    const boom = { query: async () => { throw new Error('pg down'); } };
    expect(await countEmbeddingCoverage(boom as never)).toBeNull();
  });
});
