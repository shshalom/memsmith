import { describe, expect, it, mock } from 'bun:test';

mock.module('../../../src/server/generation/embedder.js', () => ({
  embed: async () => Array.from({ length: 384 }, () => 0),
  embedBatch: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, () => 0)),
}));

import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

function fakeConnection(extversion: string) {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text.trim().split('\n')[0]!.trim());
      if (text.includes('pg_extension')) return { rows: [{ extversion }] };
      return { rows: [] };
    },
  };
  return { client, statements };
}

describe('vector search with an actor filter', () => {
  it('turns on iterative scan for pgvector 0.8 and later', async () => {
    const { client, statements } = fakeConnection('0.8.0');
    await new PostgresObservationRepository(client as never).vectorSearch({ projectId: 'p', teamId: 't', query: 'q', actor: 'reviewer' });
    expect(statements).toContain('SET hnsw.iterative_scan = relaxed_order');
    expect(statements).toContain('RESET hnsw.iterative_scan');
  });

  it('falls back to the largest ef_search on older pgvector', async () => {
    const { client, statements } = fakeConnection('0.7.4');
    await new PostgresObservationRepository(client as never).vectorSearch({ projectId: 'p', teamId: 't', query: 'q', actor: 'reviewer' });
    expect(statements).toContain('SET hnsw.ef_search = 1000');
    expect(statements.some((s) => s.includes('iterative_scan'))).toBe(false);
  });

  it('leaves an unfiltered search alone', async () => {
    const { client, statements } = fakeConnection('0.8.0');
    await new PostgresObservationRepository(client as never).vectorSearch({ projectId: 'p', teamId: 't', query: 'q' });
    expect(statements.some((s) => s.startsWith('SET') || s.includes('pg_extension'))).toBe(false);
  });
});

describe('vector search with an actor filter on a pool', () => {
  function fakePool(opts: { failQuery: boolean; failRollback: boolean }) {
    const released: unknown[] = [];
    const conn = {
      async query(text: string) {
        if (text.includes('pg_extension')) return { rows: [{ extversion: '0.8.0' }] };
        if (text === 'ROLLBACK' && opts.failRollback) throw new Error('connection lost');
        if (text.includes('FROM observations') && opts.failQuery) throw new Error('query failed');
        return { rows: [] };
      },
      release(error?: unknown) { released.push(error); },
    };
    const pool = { totalCount: 1, query: conn.query, connect: async () => conn };
    return { pool, released };
  }

  const search = (pool: unknown) => new PostgresObservationRepository(pool as never)
    .vectorSearch({ projectId: 'p', teamId: 't', query: 'q', actor: 'reviewer' });

  it('discards the connection when ROLLBACK fails, instead of returning it to the pool', async () => {
    const { pool, released } = fakePool({ failQuery: true, failRollback: true });
    await expect(search(pool)).rejects.toThrow('query failed');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('returns the connection to the pool after a clean rollback', async () => {
    const { pool, released } = fakePool({ failQuery: true, failRollback: false });
    await expect(search(pool)).rejects.toThrow('query failed');
    expect(released).toEqual([undefined]);
  });
});
