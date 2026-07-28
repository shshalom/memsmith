// SPDX-License-Identifier: Apache-2.0
//
// The Go Team copy reads rows with SELECT *, so it sees every column — including
// generated ones. Postgres rejects any INSERT that names a GENERATED ALWAYS
// column, which killed the observations copy:
//
//   cannot insert a non-DEFAULT value into column "content_search"
//
// (observations.content_search is GENERATED ALWAYS AS
// to_tsvector('english', content) STORED — the full-text index column.)
//
// The set is discovered from the DESTINATION schema rather than hardcoded. It is
// a property of the schema, so a future migration adding another generated
// column would otherwise reintroduce this crash silently. Destination rather than
// source because the INSERT is what fails, and the destination is what the
// bootstrap just created.

export interface GeneratedColumnQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** table name → set of generated column names on that table. */
export type GeneratedColumnMap = Map<string, Set<string>>;

export async function discoverGeneratedColumns(
  pool: GeneratedColumnQueryable,
): Promise<GeneratedColumnMap> {
  const result = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`,
  );
  const map: GeneratedColumnMap = new Map();
  for (const row of result.rows) {
    const table = String(row.table_name);
    const column = String(row.column_name);
    const existing = map.get(table);
    if (existing) existing.add(column);
    else map.set(table, new Set([column]));
  }
  return map;
}

/**
 * Return `rows` without the generated columns for `table`.
 *
 * Copies rather than mutates: the caller's rows are also used for row counts and
 * progress reporting. Only generated columns are dropped — every other column,
 * including nulls and falsy values, is preserved verbatim.
 */
export function stripGeneratedColumns(
  table: string,
  rows: Array<Record<string, unknown>>,
  generated: GeneratedColumnMap,
): Array<Record<string, unknown>> {
  const drop = generated.get(table);
  if (!drop || drop.size === 0 || rows.length === 0) return rows;
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (!drop.has(key)) out[key] = row[key];
    }
    return out;
  });
}
