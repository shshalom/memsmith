// SPDX-License-Identifier: Apache-2.0
import { loadCanonicalTypeIds, resolveObsType, type TaxonomyClassifier } from './classifyObservationType.js';
import { logger } from '../../../utils/logger.js';

export interface ResolvedImportRow {
  id: string;
  obsType: string;
  content: string;
}

export interface FirstRunImportDeps {
  sqliteExists: () => boolean;
  observationsEmpty: () => Promise<boolean>;
  markerExists: () => boolean;
  writeMarker: () => void;
  readSourceRows: () => Promise<Array<{ id: string; type: string; content: string }>>;
  insertRow: (row: ResolvedImportRow) => Promise<void>;
  // Optional batch insert. When provided, rows are resolved then inserted in
  // batches (far fewer round-trips than per-row insertRow). Falls back to
  // insertRow when absent, so existing callers/tests keep working.
  insertBatch?: (rows: ResolvedImportRow[]) => Promise<void>;
  classifier: TaxonomyClassifier;
}

const IMPORT_BATCH_SIZE = 200;

export async function runFirstRunImport(
  deps: FirstRunImportDeps,
): Promise<{ imported: number; skipped: boolean; reason?: string }> {
  if (deps.markerExists()) return { imported: 0, skipped: true, reason: 'marker present' };
  if (!deps.sqliteExists()) return { imported: 0, skipped: true, reason: 'no sqlite db' };
  if (!(await deps.observationsEmpty())) return { imported: 0, skipped: true, reason: 'observations table not empty' };

  const canonical = loadCanonicalTypeIds();
  const rows = await deps.readSourceRows();
  let imported = 0;
  let batch: ResolvedImportRow[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (deps.insertBatch) {
      await deps.insertBatch(batch);
    } else {
      for (const r of batch) await deps.insertRow(r);
    }
    imported += batch.length;
    batch = [];
  };

  for (const row of rows) {
    const obsType = await resolveObsType({ content: row.content, sourceType: row.type, canonical, classifier: deps.classifier });
    batch.push({ id: row.id, obsType, content: row.content });
    if (batch.length >= IMPORT_BATCH_SIZE) await flush();
  }
  await flush();

  deps.writeMarker();
  logger.info('SYSTEM', 'first-run import complete', { imported });
  return { imported, skipped: false };
}
