// SPDX-License-Identifier: Apache-2.0
//
// The "flip" persistence: writes MEMSMITH_RUNTIME/MEMSMITH_SERVER_DATABASE_URL
// into ~/.memsmith/settings.json. There is no mergeSettings helper in the repo,
// so this does a direct read-merge-write. NOTE: the running server caches
// settings once per process (hook-settings loadFromFileOnce), so a restart is
// required for a written flip to take effect — the convert service surfaces
// restartRequired to the caller.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export function writeServerModeSettings(
  patch: Record<string, string>,
  opts: { path?: string } = {},
): void {
  const path = opts.path ?? USER_SETTINGS_PATH;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) existing = {};
  } catch {
    existing = {};
  }
  const merged = { ...existing, ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
