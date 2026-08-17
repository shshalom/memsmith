// SPDX-License-Identifier: Apache-2.0
//
// Migration fidelity: an observation inserted with an explicit past timestamp must keep
// it.
//
// WHY THIS EXISTS. `created_at` is `TIMESTAMPTZ NOT NULL DEFAULT now()` and the INSERT
// column list omitted it, so every write took the default. Verified against the live team
// server: an observation POSTed with createdAt 2020-01-15 was stored with that day's
// ingest date. For fresh ingest that is correct — the row IS being created now. For a
// CONVERT, rows are being RELOCATED and their original timestamps are the data: losing
// them collapses a project's whole history to one day and breaks the recency ordering
// that readTeamWide falls back to when merging ranked results across a team's projects.
//
// BOTH BRANCHES ARE ASSERTED ON PURPOSE. `create()` has two INSERT sites — one per
// ON CONFLICT target — because Postgres permits only one ON CONFLICT per statement:
// the idempotency_key branch and the generation_key branch. They share `commonValues`
// today, but a future edit could easily diverge them, and patching one while missing the
// other is a half-fix that still passes any test exercising only the patched path.

import { describe, expect, it } from 'bun:test';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const PAST = new Date('2020-01-15T00:00:00.000Z');
// The repository normalises to an ISO string (TIMESTAMPTZ parses it unambiguously), so
// that — not the Date object — is what reaches Postgres.


/**
 * Minimal fake client. Captures the INSERT text and values so the test can assert what
 * would reach Postgres, without needing a live database for a column-list question.
 */
function makeFakeClient() {
  const inserts: Array<{ text: string; values: unknown[] }> = [];
  return {
    inserts,
    async query(text: string, values?: unknown[]) {
      // Ownership asserts run before the INSERT and must find their rows.
      if (/SELECT id FROM projects/i.test(text)) {
        return { rows: [{ id: values?.[0] }], rowCount: 1 };
      }
      if (/INSERT INTO observations/i.test(text)) {
        inserts.push({ text, values: values ?? [] });
        return {
          rows: [{
            id: values?.[0], project_id: values?.[1], team_id: values?.[2],
            server_session_id: null, kind: 'observation', content: 'c',
            generation_key: values?.[6], idempotency_key: values?.[7],
            metadata: {}, embedding: null, created_by_job_id: null,
            obs_type: null, lifecycle_state: 'open', supersedes: null,
            quality: null, promoted_at: null,
            // Echo back whatever created_at the statement supplied, so the test
            // observes the repository's intent rather than a database default.
            created_at: PAST, updated_at: PAST,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const BASE = { projectId: 'p1', teamId: 't1', content: 'relocated row' };

describe('observation timestamp fidelity on insert', () => {
  it('names created_at in the INSERT when createdAt is supplied (idempotency branch)', async () => {
    const client = makeFakeClient();
    await new PostgresObservationRepository(client as never).create({
      ...BASE, idempotencyKey: 'idem-1', createdAt: PAST,
    });

    const stmt = client.inserts[client.inserts.length - 1]!;
    // The column must be NAMED. Without it the row silently takes DEFAULT now(),
    // which is the exact regression this pins.
    expect(stmt.text).toMatch(/created_at/);
    expect(stmt.values).toContain(PAST.toISOString());
  });

  it('names created_at in the INSERT when createdAt is supplied (generation-key branch)', async () => {
    const client = makeFakeClient();
    await new PostgresObservationRepository(client as never).create({
      ...BASE, generationKey: 'gen-1', createdAt: PAST,
    });

    const stmt = client.inserts[client.inserts.length - 1]!;
    expect(stmt.text).toMatch(/created_at/);
    expect(stmt.values).toContain(PAST.toISOString());
  });

  it('omits created_at entirely when not supplied, so fresh ingest still defaults to now()', async () => {
    const client = makeFakeClient();
    await new PostgresObservationRepository(client as never).create({
      ...BASE, idempotencyKey: 'idem-2',
    });

    const stmt = client.inserts[client.inserts.length - 1]!;
    // Fresh ingest must NOT pin a timestamp: passing an explicit null would violate
    // the NOT NULL constraint, and passing now() from the app clock would replace a
    // database-authoritative value with a client-skewed one.
    expect(stmt.text).not.toMatch(/created_at/);
  });

  it('carries embedding_vec as a vector literal rather than regenerating it', async () => {
    const client = makeFakeClient();
    await new PostgresObservationRepository(client as never).create({
      ...BASE, idempotencyKey: 'idem-3', embeddingVec: [0.5, -0.25, 0.125],
    });

    const stmt = client.inserts[client.inserts.length - 1]!;
    // A migration must relocate the existing vector. Regenerating risks NULL when the
    // embedder is unavailable, and a row-count check cannot detect that loss.
    expect(stmt.values).toContain('[0.5,-0.25,0.125]');
    expect(stmt.text).toMatch(/embedding_vec/);
  });
});
