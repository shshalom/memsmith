// SPDX-License-Identifier: Apache-2.0
import { ModeManager } from '../../../services/domain/ModeManager.js';
import { logger } from '../../../utils/logger.js';

const FALLBACK_TYPE = 'change';

export interface TaxonomyClassifier {
  classify(input: { content: string; sourceType: string }): Promise<string | null>;
}

export function loadCanonicalTypeIds(): string[] {
  try {
    const mode = ModeManager.getInstance().getActiveMode() as { observation_types?: Array<{ id: string }> };
    const ids = (mode.observation_types ?? []).map((t) => t.id).filter(Boolean);
    if (ids.length > 0) return ids;
  } catch (error) {
    logger.warn('SYSTEM', 'could not load active mode taxonomy; using fallback', {}, error instanceof Error ? error : new Error(String(error)));
  }
  return ['discovery', 'progress', 'blocker', 'decision'];
}

export async function resolveObsType(args: {
  content: string;
  sourceType: string;
  canonical: string[];
  classifier: TaxonomyClassifier;
}): Promise<string> {
  const canon = new Set(args.canonical);
  // Already canonical → keep verbatim, no model drift.
  if (canon.has(args.sourceType)) return args.sourceType;
  try {
    const label = await args.classifier.classify({ content: args.content, sourceType: args.sourceType });
    if (label && canon.has(label)) return label;
  } catch (error) {
    logger.warn('SYSTEM', 'taxonomy classify failed; using fallback', { sourceType: args.sourceType }, error instanceof Error ? error : new Error(String(error)));
  }
  return canon.has(FALLBACK_TYPE) ? FALLBACK_TYPE : args.canonical[0] ?? FALLBACK_TYPE;
}
