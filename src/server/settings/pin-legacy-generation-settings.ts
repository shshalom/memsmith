// SPDX-License-Identifier: Apache-2.0
//
// Installs that predate MEMSMITH_SERVER_PROVIDER generate with Ollama only
// because Ollama used to be the registry default. Now that the default is a
// cloud provider, those installs are pinned to their current setup so an update
// never moves their memory generation to the cloud without consent.

import { chmodSync, writeFileSync } from 'node:fs';
import { readFlatSettings } from '../../shared/flat-settings.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const LEGACY_OLLAMA_MODEL = 'qwen2.5:14b';

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function legacyGenerationPins(
  settings: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, string> | null {
  if (!Object.keys(settings).some(key => key.startsWith('MEMSMITH_'))) return null;
  const pins = {
    MEMSMITH_SERVER_PROVIDER: 'ollama',
    MEMSMITH_SERVER_MODEL: nonEmpty(settings.MEMSMITH_OLLAMA_MODEL) ?? LEGACY_OLLAMA_MODEL,
  };
  const savedProvider = nonEmpty(settings.MEMSMITH_SERVER_PROVIDER);
  // An Ollama install with no model ran the old default; the new default must not swap its model.
  if (savedProvider) {
    return savedProvider.toLowerCase() === 'ollama' && !nonEmpty(settings.MEMSMITH_SERVER_MODEL) ? pins : null;
  }
  return nonEmpty(env.MEMSMITH_SERVER_PROVIDER) ? null : pins;
}

export function pinLegacyGenerationSettings(opts: {
  path?: string;
  env?: Record<string, string | undefined>;
} = {}): Record<string, string> | null {
  const path = opts.path ?? USER_SETTINGS_PATH;
  let settings: Record<string, unknown> | null;
  try {
    settings = readFlatSettings(path);
  } catch {
    return null;
  }
  if (!settings) return null;
  const pins = legacyGenerationPins(settings, opts.env ?? process.env);
  if (!pins) return null;
  try {
    writeFileSync(path, JSON.stringify({ ...settings, ...pins }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    logger.warn('SYSTEM', 'Could not pin the legacy generation settings', { path },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  logger.info('SYSTEM', 'Pinned this install to its current local generation provider', {
    provider: pins.MEMSMITH_SERVER_PROVIDER,
    model: pins.MEMSMITH_SERVER_MODEL,
  });
  return pins;
}
