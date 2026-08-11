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
import { homedir } from 'os';
import { styleText } from 'node:util';

const KEY = 'MEMSMITH_RETRIEVAL_ENFORCEMENT';

export function defaultSettingsPath(): string {
  return join(homedir(), '.memsmith', 'settings.json');
}

/** Current mode. Any unreadable/corrupt/absent state reports 'soft' — the
 *  conservative answer, since soft never blocks. */
export function readEnforcement(settingsPath: string = defaultSettingsPath()): string {
  try {
    if (!existsSync(settingsPath)) return 'soft';
    const j = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    return j[KEY] === 'hard' ? 'hard' : 'soft';
  } catch {
    return 'soft';
  }
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

export function runEnforcementCommand(argv: string[]): void {
  const sub = (argv[0] ?? 'status').toLowerCase();
  if (sub === 'status') {
    console.log(`memory-first enforcement: ${readEnforcement()}`);
    return;
  }
  if (sub === 'on' || sub === 'hard') {
    setEnforcement('hard');
    console.log(styleText('green', 'memory-first enforcement: hard'));
    console.log('Memory is consulted before discovery searches; code is the verification pass.');
    console.log('Disable at any time with: npx memsmith enforcement off');
    return;
  }
  if (sub === 'off' || sub === 'soft') {
    setEnforcement('soft');
    console.log(styleText('yellow', 'memory-first enforcement: soft (inject-only, never blocks)'));
    return;
  }
  console.error(styleText('red', `Unknown enforcement subcommand: ${sub}`));
  console.error('Usage: npx memsmith enforcement on|off|status');
  process.exit(1);
}
