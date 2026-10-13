// SPDX-License-Identifier: Apache-2.0

export type InstallRuntimeId = 'local' | 'server';

/**
 * Normalize a `--runtime` flag or a stored MEMSMITH_RUNTIME to a canonical id.
 * `worker` and `server-beta` are legacy aliases that existing settings files
 * and scripts still carry. Returns null for an unknown value.
 */
export function normalizeRuntimeFlag(value: string | undefined): InstallRuntimeId | null {
  if (value === undefined) return 'local';
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'local' || normalized === 'worker') return 'local';
  if (normalized === 'server' || normalized === 'server-beta') return 'server';
  return null;
}

// Phase 1d back-compat: also clear the legacy MEMSMITH_SERVER_BETA_*
// settings keys so an uninstall fully tears down installs done before the
// rename.
export const SERVER_RUNTIME_SETTINGS_KEYS: readonly string[] = Object.freeze([
  'MEMSMITH_RUNTIME',
  'MEMSMITH_SERVER_URL',
  'MEMSMITH_SERVER_API_KEY',
  'MEMSMITH_SERVER_PROJECT_ID',
  'MEMSMITH_SERVER_BETA_URL',
  'MEMSMITH_SERVER_BETA_API_KEY',
  'MEMSMITH_SERVER_BETA_PROJECT_ID',
]);
