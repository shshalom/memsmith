// SPDX-License-Identifier: Apache-2.0
import { loadCanonicalTypeIds, resolveObsType, type TaxonomyClassifier } from './classifyObservationType.js';
import { logger } from '../../../utils/logger.js';

export interface FirstRunImportDeps {
  sqliteExists: () => boolean;
  observationsEmpty: () => Promise<boolean>;
  markerExists: () => boolean;
  writeMarker: () => void;
  readSourceRows: () => Promise<Array<{ id: string; type: string; content: string }>>;
  insertRow: (row: { id: string; obsType: string; content: string }) => Promise<void>;
  classifier: TaxonomyClassifier;
}

export async function runFirstRunImport(
  deps: FirstRunImportDeps,
): Promise<{ imported: number; skipped: boolean; reason?: string }> {
  if (deps.markerExists()) return { imported: 0, skipped: true, reason: 'marker present' };
  if (!deps.sqliteExists()) return { imported: 0, skipped: true, reason: 'no sqlite db' };
  if (!(await deps.observationsEmpty())) return { imported: 0, skipped: true, reason: 'observations table not empty' };

  const canonical = loadCanonicalTypeIds();
  const rows = await deps.readSourceRows();
  let imported = 0;
  for (const row of rows) {
    const obsType = await resolveObsType({ content: row.content, sourceType: row.type, canonical, classifier: deps.classifier });
    await deps.insertRow({ id: row.id, obsType, content: row.content });
    imported += 1;
  }
  deps.writeMarker();
  logger.info('SYSTEM', 'first-run import complete', { imported });
  return { imported, skipped: false };
}
