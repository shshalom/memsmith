// src/npx-cli/commands/enforcement.ts
// SPDX-License-Identifier: Apache-2.0
//
// `memsmith enforcement on|off|status` — the non-gated escape hatch for
// memory-first enforcement.
//
// WHY THIS EXISTS. Hard mode denies gated tool calls. If the only way to turn it
// off were itself a gated tool call, the agent could not disable the mode that is
// blocking it, and the user would be left hand-editing JSON — which is exactly
// how hard mode got reverted in July 2026. This command runs in the user's own
// shell, so it is never tool-gated.
//
// WHY IT WRITES THE FILE DIRECTLY. Hooks read ~/.memsmith/settings.json via
// loadFromFileOnce. `PATCH /v1/settings` is a DIFFERENT store — team overrides in
// Postgres keyed by teamId — and MEMSMITH_RETRIEVAL_ENFORCEMENT is not among its
// 18 registered keys. So the dashboard route cannot toggle this; the file can.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { styleText } from 'node:util';
import { resolveDataDir } from '../../shared/paths.js';
import {
  ENFORCEMENT_KEY as KEY,
  defaultEnforcementMode,
  toEnforcementMode,
} from '../../services/retrieval/enforcement-mode.js';
import type { EnforcementMode } from '../../services/retrieval/types.js';

/** The file the hooks read (USER_SETTINGS_PATH), resolved at call time. */
export function defaultSettingsPath(): string {
  return join(resolveDataDir(), 'settings.json');
}

export interface EnforcementStatus {
  mode: EnforcementMode;
  source: 'default' | 'settings' | 'env';
}

function readSettingsValue(settingsPath: string): unknown {
  try {
    if (!existsSync(settingsPath)) return undefined;
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8').replace(/^\uFEFF/, ''));
    const flat = parsed?.env && typeof parsed.env === 'object' ? parsed.env : parsed;
    return flat?.[KEY];
  } catch {
    return undefined;
  }
}

/**
 * The mode the hooks actually run with, resolved the way
 * SettingsDefaultsManager.loadFromFile does: environment variable, then
 * settings.json, then the shipped default. An unreadable file falls back to the
 * default because that is what the runtime does with it.
 */
export function readEnforcementStatus(
  settingsPath: string = defaultSettingsPath(),
  env: Record<string, string | undefined> = process.env,
): EnforcementStatus {
  if (env[KEY] !== undefined) return { mode: toEnforcementMode(env[KEY]), source: 'env' };
  const fromFile = readSettingsValue(settingsPath);
  if (fromFile !== undefined) return { mode: toEnforcementMode(fromFile), source: 'settings' };
  return { mode: defaultEnforcementMode(), source: 'default' };
}

export function readEnforcement(
  settingsPath: string = defaultSettingsPath(),
  env: Record<string, string | undefined> = process.env,
): EnforcementMode {
  return readEnforcementStatus(settingsPath, env).mode;
}

const SOURCE_LABEL: Record<EnforcementStatus['source'], string> = {
  default: 'default',
  settings: 'set in settings.json',
  env: `set by the ${KEY} environment variable`,
};

export function formatEnforcementStatus(status: EnforcementStatus): string {
  return `memory-first enforcement: ${status.mode} (${SOURCE_LABEL[status.source]})`;
}

/** Read-modify-write so unrelated settings survive. A corrupt file is replaced
 *  rather than propagated — otherwise the escape hatch could be jammed by a bad
 *  file, which is the one failure this command must not have. */
export function setEnforcement(
  mode: 'hard' | 'soft',
  settingsPath: string = defaultSettingsPath(),
): void {
  let j: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        j = parsed as Record<string, unknown>;
      }
    }
  } catch {
    j = {};
  }
  j[KEY] = mode;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(j, null, 2)}\n`, 'utf-8');
}

function warnIfEnvOverrides(): void {
  if (process.env[KEY] === undefined) return;
  console.log(styleText('yellow', `${KEY}=${process.env[KEY]} is set in this environment and overrides settings.json.`));
}

export function runEnforcementCommand(argv: string[]): void {
  const sub = (argv[0] ?? 'status').toLowerCase();
  if (sub === 'status') {
    console.log(formatEnforcementStatus(readEnforcementStatus()));
    return;
  }
  if (sub === 'on' || sub === 'hard') {
    setEnforcement('hard');
    console.log(styleText('green', 'memory-first enforcement: hard'));
    console.log('Memory is consulted before discovery searches and before answering questions about past work;');
    console.log('code is the verification pass.');
    console.log('Disable at any time with: npx memsmith enforcement off');
    warnIfEnvOverrides();
    return;
  }
  if (sub === 'off' || sub === 'soft') {
    setEnforcement('soft');
    console.log(styleText('yellow', 'memory-first enforcement: soft (inject-only, never blocks)'));
    warnIfEnvOverrides();
    return;
  }
  console.error(styleText('red', `Unknown enforcement subcommand: ${sub}`));
  console.error('Usage: npx memsmith enforcement on|off|status');
  process.exit(1);
}
