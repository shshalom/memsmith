// SPDX-License-Identifier: Apache-2.0
//
// vectorSearch ordered by cosine distance, then threw the distance away. Two
// consequences, both invisible:
//
// 1. A query whose terms appear NOWHERE in the corpus still returned a full,
//    confident top-N. Probed live against the dogfood: the term
//    "zzqqxx_no_such_term_9987" returned 5 entirely unrelated observations, and
//    nothing in the payload let the caller tell them from real hits.
//
// 2. RetrievalBroker declares a memory gap via `hitCount < minHits` with
//    minHits defaulting to 1. Since search never returned fewer than 1 row, the
//    gap branch was unreachable — confirmed empirically by ZERO kind='memory_gap'
//    rows across 5,217 observations. The detector existed, was wired, and had
//    never fired once.
//
// The floor is derived from measurement, not guessed. Across 90 queries on the
// live corpus (60 drawn from real observation content, 30 off-domain):
//   REAL     n=60  min=0.1189  p50=0.2836  p90=0.4257  max=0.4872
//   NONSENSE n=30  min=0.6147  p50=0.7609  max=0.8775
// The populations do not overlap; a floor anywhere in (0.4872, 0.6147) keeps
// 100% of real hits and rejects 100% of off-domain ones. DEFAULT_MAX_DISTANCE
// sits at 0.55, near the middle of that empty band.
import { describe, it, expect } from 'bun:test';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

/**
 * Fake client returning rows with a controllable distance, so the SQL contract
 * (distance is selected, the floor is bound, filtering happens in SQL) can be
 * asserted without Postgres.
 */
function fakeClient(rows: Array<{ id: string; dist: number }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      // Mimic the SQL floor so a filtering bug in the query shows up here.
      const floor = values[4] as number | null;
      const kept = floor === null || floor === undefined
        ? rows
        : rows.filter(r => r.dist <= floor);
      return {
        rows: kept.map(r => ({
          id: r.id, project_id: 'p', team_id: 't', server_session_id: null,
          kind: 'observation', content: `row ${r.id}`, generation_key: null,
          idempotency_key: null, metadata: {}, embedding: null,
          created_by_job_id: null, obs_type: null, lifecycle_state: 'open',
          supersedes: null, quality: null, embedding_vec: null,
          created_at: new Date(0), updated_at: new Date(0),
          __distance: r.dist,
        })),
        rowCount: kept.length,
      };
    },
  };
}

const ARGS = { projectId: 'p', teamId: 't', query: 'anything' };

describe('vectorSearch relevance', () => {
  it('exposes the distance so callers can tell a hit from noise', async () => {
    const client = fakeClient([{ id: 'a', dist: 0.12 }, { id: 'b', dist: 0.83 }]);
    const repo = new PostgresObservationRepository(client as never);
    const rows = await repo.vectorSearch(ARGS);
    expect(rows.map(r => r.distance)).toEqual([0.12, 0.83]);
  });

  it('selects the distance rather than only ordering by it', async () => {
    const client = fakeClient([{ id: 'a', dist: 0.2 }]);
    await new PostgresObservationRepository(client as never).vectorSearch(ARGS);
    // Ordering alone is what discarded the information.
    expect(client.calls[0]!.text).toMatch(/AS __distance/);
  });

  it('returns everything when no floor is given (unchanged default behaviour)', async () => {
    const client = fakeClient([{ id: 'a', dist: 0.1 }, { id: 'b', dist: 0.9 }]);
    const rows = await new PostgresObservationRepository(client as never).vectorSearch(ARGS);
    expect(rows).toHaveLength(2);
    expect(client.calls[0]!.values[4]).toBeNull();
  });

  it('drops rows beyond the floor when one is given', async () => {
    const client = fakeClient([
      { id: 'near', dist: 0.30 },
      { id: 'edge', dist: 0.55 },
      { id: 'far', dist: 0.72 },
    ]);
    const rows = await new PostgresObservationRepository(client as never)
      .vectorSearch({ ...ARGS, maxDistance: 0.55 });
    expect(rows.map(r => r.id)).toEqual(['near', 'edge']);
  });

  it('returns NOTHING when every candidate is beyond the floor', async () => {
    // The case that makes gap detection possible at all: an honest empty result
    // instead of five confident, unrelated rows.
    const client = fakeClient([{ id: 'x', dist: 0.79 }, { id: 'y', dist: 0.88 }]);
    const rows = await new PostgresObservationRepository(client as never)
      .vectorSearch({ ...ARGS, maxDistance: 0.55 });
    expect(rows).toEqual([]);
  });

  it('filters in SQL so LIMIT applies to rows that already passed the floor', async () => {
    // Filtering in JS after the fact would return fewer than `limit` usable
    // rows whenever near matches were pushed out by far ones.
    const client = fakeClient([{ id: 'a', dist: 0.2 }]);
    await new PostgresObservationRepository(client as never)
      .vectorSearch({ ...ARGS, limit: 5, maxDistance: 0.6 });
    const { text, values } = client.calls[0]!;
    expect(text).toMatch(/WHERE[\s\S]*<=\s*\$5::float8/);
    expect(values[3]).toBe(5);
    expect(values[4]).toBe(0.6);
  });

  it('omits distance rather than emitting NaN when the driver returns junk', async () => {
    const client = {
      async query() {
        return {
          rows: [{
            id: 'a', project_id: 'p', team_id: 't', server_session_id: null,
            kind: 'observation', content: 'c', generation_key: null,
            idempotency_key: null, metadata: {}, embedding: null,
            created_by_job_id: null, obs_type: null, lifecycle_state: 'open',
            supersedes: null, quality: null, embedding_vec: null,
            created_at: new Date(0), updated_at: new Date(0),
            __distance: 'not-a-number',
          }],
          rowCount: 1,
        };
      },
    };
    const rows = await new PostgresObservationRepository(client as never).vectorSearch(ARGS);
    // A NaN distance would compare false against every threshold and silently
    // drop the row downstream; absent is honest, NaN is a trap.
    expect(rows[0]!.distance).toBeUndefined();
  });
});
