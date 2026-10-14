// src/services/retrieval/enforcement-mode.ts
// SPDX-License-Identifier: Apache-2.0
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import type { EnforcementMode } from './types.js';

export const ENFORCEMENT_KEY = 'MEMSMITH_RETRIEVAL_ENFORCEMENT';

/** Anything other than an explicit 'hard' is soft, the mode that never blocks. */
export function toEnforcementMode(raw: unknown): EnforcementMode {
  return raw === 'hard' ? 'hard' : 'soft';
}

export function enforcementModeFromSettings(settings: Record<string, string | undefined>): EnforcementMode {
  return toEnforcementMode(settings[ENFORCEMENT_KEY]);
}

export function defaultEnforcementMode(): EnforcementMode {
  return toEnforcementMode(SettingsDefaultsManager.getAllDefaults().MEMSMITH_RETRIEVAL_ENFORCEMENT);
}
