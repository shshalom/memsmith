-- SPDX-License-Identifier: Apache-2.0
-- Source-of-truth SQL; not loaded by code (DDL is embedded in schema.ts).
-- Content-idempotency key for manual record-intent writes. Two detection
-- layers + retries compute the same key for the same note, collapsing to
-- one row via the partial unique index.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_idempotency
  ON observations (team_id, project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
