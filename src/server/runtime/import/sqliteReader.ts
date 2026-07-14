// SPDX-License-Identifier: Apache-2.0
// Thin reader over the worker's SQLite observations table. Mirrors how
// scripts/migrate-claude-mem.ts opens the source DB. Runs under Bun, so
// bun:sqlite is available. Returns the {id,type,content} row shape the
// first-run importer expects; rows with empty content are skipped.
import { Database } from 'bun:sqlite';

interface SourceObservationRow {
  id: unknown;
  type: unknown;
  text: unknown;
  title: unknown;
  subtitle: unknown;
  narrative: unknown;
}

export async function readWorkerObservations(
  sqlitePath: string,
): Promise<Array<{ id: string; type: string; content: string }>> {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const rows = db
      .prepare('SELECT id, type, text, title, subtitle, narrative FROM observations')
      .all() as SourceObservationRow[];
    const out: Array<{ id: string; type: string; content: string }> = [];
    for (const r of rows) {
      const content = String(
        r.text ||
          r.narrative ||
          [r.title, r.subtitle].filter(Boolean).join(' — ') ||
          '',
      );
      if (!content.trim()) continue;
      out.push({
        id: String(r.id),
        type: String(r.type ?? 'change'),
        content,
      });
    }
    return out;
  } finally {
    db.close();
  }
}
