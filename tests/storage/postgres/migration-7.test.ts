// SPDX-License-Identifier: Apache-2.0
//
// Migration 7 adds the two objects convert-over-HTTPS needs:
//
//   observations.promoted_at    — LOCAL bookkeeping. NULL means "not in the team yet"
//                                 and drives the wizard's sync count. Never read on the
//                                 remote: a row in the team database is already there.
//   convert_import_batches      — per-BATCH idempotency for the HTTPS import.
//
// Batch-level idempotency is not a stylistic choice. Row-level cannot carry it: only
// 367 of 10,762 observations in a real long-lived project have an idempotency_key
// (3.4%), and the unique index is partial (WHERE idempotency_key IS NOT NULL), so the
// remaining 96.6% bypass it entirely and a retried batch would duplicate them.

import { describe, expect, it } from 'bun:test';
import { SERVER_POSTGRES_SCHEMA_VERSION } from '../../../src/storage/postgres/schema.js';

describe('migration 7', () => {
  it('bumps the schema version to 7', () => {
    // The version gate is what triggers the DDL, so the constant and the migration
    // must land in the same change — otherwise the migration never runs.
    expect(SERVER_POSTGRES_SCHEMA_VERSION).toBe(7);
  });
});
