// SPDX-License-Identifier: Apache-2.0
import { tierToBudget, type TierInput } from './tiering.js';
import { buildCompressionEvent } from './compressionMetering.js';
import type { PostgresUsageRepository } from '../../storage/postgres/usage.js';
import { logger } from '../../utils/logger.js';

export interface RecordServedCompressionDeps {
  usage: PostgresUsageRepository;
  teamId: string;
  projectId: string | null;
  rows: TierInput[];
  maxChars: number;
  maxItems: number;
}

// Measures what tiering compression would save on the memory rows the server
// returns for /v1/context, and records one 'compression' usage event per row
// that actually shrank. Server-executed, gated by MEMSMITH_USAGE_METERING, and
// NEVER throws — a metering failure must not affect the context response.
export async function recordServedCompression(deps: RecordServedCompressionDeps): Promise<void> {
  if (process.env.MEMSMITH_USAGE_METERING !== '1') return;
  try {
    const visible = deps.rows.slice(0, Math.max(0, deps.maxItems));
    if (visible.length === 0) return;
    const rendered = tierToBudget(visible, { maxChars: deps.maxChars, maxItems: deps.maxItems });
    for (let i = 0; i < rendered.length; i++) {
      const preChars = (visible[i]?.content ?? '').length;
      const postChars = rendered[i].length;
      if (preChars > postChars) {
        await deps.usage.record(buildCompressionEvent(deps.teamId, deps.projectId, preChars, postChars, 'served'));
      }
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'served-compression metering failed; ignoring', { teamId: deps.teamId }, err);
  }
}
