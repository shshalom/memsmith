// SPDX-License-Identifier: Apache-2.0
//
// Applies one imported batch, server-side.
//
// WHY THIS CANNOT LIVE IN THE CLIENT. discoverGeneratedColumns queries
// information_schema on the DESTINATION connection (generated-columns.ts:12-16),
// deliberately, so that a future migration adding a generated column cannot silently
// reintroduce the insert crash it was written to prevent. An HTTPS client has no
// destination connection, so stripping happens here. Hardcoding the column list in the
// client would give back exactly the silent breakage that check exists to catch.
//
// SCOPE COMES FROM THE CREDENTIAL, NEVER THE ROW. Rows arrive over the network and carry
// their own project_id/team_id. Trusting those would let an authenticated caller write
// into another tenant by editing a payload, so both are overwritten with the
// authenticated values. This is the row-level counterpart to the route's owner gate.

import { discoverGeneratedColumns, stripGeneratedColumns } from './generated-columns.js';

export interface ApplyDeps {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ApplyInput {
  projectId: string;
  teamId: string;
  table: string;
  rows: Array<Record<string, unknown>>;
  batchToken: string;
}

/**
 * Columns held back at insert time and applied in a second pass.
 *
 * `observations.supersedes` is a SELF-referential FK (schema.ts:471-472). Within a single
 * table a superseding row can arrive before the row it points at, so naming the column on
 * insert would fail on a forward reference. Ordering tables cannot fix it — the conflict
 * is inside one table.
 */
export const DEFERRED_COLUMNS: Record<string, string[]> = {
  observations: ['supersedes'],
};

export async function applyImportBatch(
  deps: ApplyDeps,
  input: ApplyInput,
): Promise<{ applied: number; status: 'applied' | 'already_applied' }> {
  const seen = await deps.query(
    `SELECT batch_token FROM convert_import_batches
      WHERE project_id = $1 AND table_name = $2 AND batch_token = $3`,
    [input.projectId, input.table, input.batchToken],
  );
  // Idempotency is per BATCH, not per row: most observations carry no idempotency_key
  // and its unique index is partial, so row-level conflict handling cannot make a retry
  // safe on its own.
  if (seen.rows.length > 0) return { applied: 0, status: 'already_applied' };

  if (input.rows.length === 0) {
    // Still record the token: an empty batch is a legitimate outcome (a table with no
    // rows for this project), and a retry of it must stay a no-op.
    await recordToken(deps, input);
    return { applied: 0, status: 'applied' };
  }

  const generated = await discoverGeneratedColumns(deps as never);
  const deferred = DEFERRED_COLUMNS[input.table] ?? [];
  const deferredLinks: Array<{ id: unknown; values: Record<string, unknown> }> = [];

  const writable = stripGeneratedColumns(input.table, input.rows, generated);

  for (const row of writable) {
    const scoped: Record<string, unknown> = { ...row };
    // Authenticated scope wins over anything the payload claims. Only overwrite columns
    // the table actually has, so a table without them is untouched.
    if ('project_id' in scoped) scoped.project_id = input.projectId;
    if ('team_id' in scoped) scoped.team_id = input.teamId;

    const held: Record<string, unknown> = {};
    for (const col of deferred) {
      if (scoped[col] != null) {
        held[col] = scoped[col];
        delete scoped[col];
      }
    }
    if (Object.keys(held).length > 0) deferredLinks.push({ id: scoped.id, values: held });

    const cols = Object.keys(scoped);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    // ON CONFLICT DO NOTHING guards the primary key; the batch token is the real
    // retry protection, since most rows have no unique business key to conflict on.
    await deps.query(
      `INSERT INTO ${input.table} (${colList}) VALUES (${placeholders})
       ON CONFLICT DO NOTHING`,
      cols.map(c => scoped[c]),
    );
  }

  // Deferred pass: every row of this batch now exists, so self-FK targets inside the
  // batch resolve. The EXISTS guard makes a target that has not arrived yet a no-op
  // rather than an FK violation — the link is simply re-applied when that batch lands.
  for (const link of deferredLinks) {
    for (const [col, value] of Object.entries(link.values)) {
      await deps.query(
        `UPDATE ${input.table} SET ${col} = $1 WHERE id = $2
          AND EXISTS (SELECT 1 FROM ${input.table} WHERE id = $1)`,
        [value, link.id],
      );
    }
  }

  await recordToken(deps, input);
  return { applied: writable.length, status: 'applied' };
}

async function recordToken(deps: ApplyDeps, input: ApplyInput): Promise<void> {
  await deps.query(
    `INSERT INTO convert_import_batches (project_id, table_name, batch_token)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [input.projectId, input.table, input.batchToken],
  );
}
