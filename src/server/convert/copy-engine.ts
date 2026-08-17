// SPDX-License-Identifier: Apache-2.0
//
// Postgres→Postgres idempotent copy for the Go Team conversion. Models its
// batch + idempotency discipline on src/server/runtime/import/firstRunImport.ts.
import { stampAttribution } from '../routes/v1/attribution.js';

export interface CopyDeps {
  readRows: (table: string) => Promise<Array<Record<string, unknown>>>;
  upsertRows: (table: string, rows: Array<Record<string, unknown>>) => Promise<void>;
  countRows: (which: 'local' | 'remote', table: string) => Promise<number>;
}
export interface CopyProgress { table: string; copied: number; }

// FK-safe order: parents before children. Team-account tables (teams,
// team_members, api_keys, server_settings) are intentionally NOT copied —
// the destination team already exists (see scoped-convert-copy spec, D2).
export const COPY_TABLES: string[] = [
  'projects',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
];

export const COPY_BATCH_SIZE = 200;

export async function runCopy(
  deps: CopyDeps,
  ownerUserId: string,
  onProgress?: (p: CopyProgress) => void,
): Promise<{ copiedByTable: Record<string, number> }> {
  const copiedByTable: Record<string, number> = {};
  for (const table of COPY_TABLES) {
    const rows = await deps.readRows(table);
    let copied = 0;
    let batch: Array<Record<string, unknown>> = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await deps.upsertRows(table, batch);
      copied += batch.length;
      batch = [];
    };
    for (const row of rows) {
      const out = table === 'observations'
        ? { ...row, metadata: stampAttribution((row.metadata as Record<string, unknown>) ?? {}, { userId: ownerUserId }) }
        : row;
      batch.push(out);
      if (batch.length >= COPY_BATCH_SIZE) await flush();
    }
    await flush();
    copiedByTable[table] = copied;
    onProgress?.({ table, copied });
  }
  return { copiedByTable };
}

export async function verifyCopy(
  deps: CopyDeps,
): Promise<{ ok: boolean; mismatches: Array<{ table: string; local: number; remote: number }> }> {
  const mismatches: Array<{ table: string; local: number; remote: number }> = [];
  for (const table of COPY_TABLES) {
    const local = await deps.countRows('local', table);
    const remote = await deps.countRows('remote', table);
    // EQUALITY, not sufficiency. `remote < local` alone missed the over-copy case: with
    // per-batch idempotency and no cross-batch transaction, a partially-applied retry can
    // leave MORE rows on the destination than the source, and that used to pass
    // verification while being wrong. The flip to team mode is gated on this result, so
    // "at least as many" is not good enough.
    if (remote !== local) mismatches.push({ table, local, remote });
  }
  return { ok: mismatches.length === 0, mismatches };
}
