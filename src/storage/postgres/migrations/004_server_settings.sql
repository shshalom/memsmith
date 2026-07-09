-- SPDX-License-Identifier: Apache-2.0
-- Source-of-truth SQL; not loaded by code (DDL is embedded in schema.ts).
-- Per-team server-mode capability overrides for the Settings/Control panel.
CREATE TABLE IF NOT EXISTS server_settings (
  team_id    text PRIMARY KEY,
  overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
