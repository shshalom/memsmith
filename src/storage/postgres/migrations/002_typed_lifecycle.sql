-- SPDX-License-Identifier: Apache-2.0
-- Migration 002: typed obs_type + lifecycle_state + supersedes + quality
-- Source-of-truth SQL; not loaded by code (DDL is embedded in schema.ts PHASE_1_SCHEMA_SQL).
ALTER TABLE observations ADD COLUMN IF NOT EXISTS obs_type TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_lifecycle_state_check;
ALTER TABLE observations ADD CONSTRAINT observations_lifecycle_state_check
  CHECK (lifecycle_state IN ('open','active','blocked','deferred','resolved','superseded'));
ALTER TABLE observations ADD COLUMN IF NOT EXISTS supersedes TEXT
  REFERENCES observations(id) ON DELETE SET NULL;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS quality SMALLINT;
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_quality_range_check;
ALTER TABLE observations ADD CONSTRAINT observations_quality_range_check
  CHECK (quality IS NULL OR (quality >= 0 AND quality <= 100));
UPDATE observations SET obs_type = metadata->>'type' WHERE obs_type IS NULL AND metadata ? 'type';
UPDATE observations SET lifecycle_state = 'resolved'
  WHERE lifecycle_state = 'open'
    AND obs_type IN ('knowledge','gotcha','change','discovery','progress','feature','refactor','security','security_note','security_alert');
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(team_id, project_id, obs_type) WHERE obs_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_lifecycle ON observations(team_id, project_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_observations_active_work ON observations(team_id, project_id, lifecycle_state, updated_at DESC)
  WHERE lifecycle_state IN ('open','active','blocked','deferred');
