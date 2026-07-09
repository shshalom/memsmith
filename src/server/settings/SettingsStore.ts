// SPDX-License-Identifier: Apache-2.0
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';

export class SettingsStore {
  constructor(private readonly db: PostgresQueryable) {}

  async getTeamOverrides(teamId: string): Promise<Record<string, unknown>> {
    try {
      const { rows } = await this.db.query<{ overrides: Record<string, unknown> }>(
        `SELECT overrides FROM server_settings WHERE team_id = $1`,
        [teamId],
      );
      const o = rows[0]?.overrides;
      return o && typeof o === 'object' ? o : {};
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'settings: getTeamOverrides failed; treating as no overrides', { teamId }, err);
      return {};
    }
  }

  async putTeamOverrides(teamId: string, patch: Record<string, unknown>): Promise<void> {
    // jsonb concat (||) merges the patch on top of existing keys.
    await this.db.query(
      `INSERT INTO server_settings (team_id, overrides, updated_at)
         VALUES ($1, $2::jsonb, now())
       ON CONFLICT (team_id) DO UPDATE
         SET overrides = server_settings.overrides || EXCLUDED.overrides,
             updated_at = now()`,
      [teamId, JSON.stringify(patch)],
    );
  }
}
