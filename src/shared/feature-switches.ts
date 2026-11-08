// SPDX-License-Identifier: Apache-2.0
import { readFlatSettings } from './flat-settings.js';
import { USER_SETTINGS_PATH } from './paths.js';
import { logger } from '../utils/logger.js';

export const HOOK_FEATURES = [
  'capture',
  'summary',
  'context',
  'prompt-injection',
  'record-intent',
  'answer-gate',
  'memory-first-gate',
  'discovery-context',
  'file-context',
  'subagent-directive',
] as const;

export type HookFeature = (typeof HOOK_FEATURES)[number];
export type MemoryMode = 'read' | 'write';
export type SwitchSource = 'env' | 'settings' | 'default';

export const READ_ONLY_REFUSAL =
  'MemSmith is in read-only mode for this session (MEMSMITH_MODE=read). Nothing was saved.';

export const READ_ONLY_SESSION_NOTICE =
  'MEMSMITH READ-ONLY SESSION: MemSmith memory is read-only in this session (MEMSMITH_MODE=read). '
  + 'Search and read memory as usual. Nothing from this session is recorded, and the write tools '
  + '(note_add, observation_add, observation_record_event) refuse. If the user asks you to remember '
  + 'something, tell them that memory is read-only in this session.';

export interface FeatureSwitches {
  mode: MemoryMode;
  modeSource: SwitchSource;
  invalidMode: string | null;
  disabled: ReadonlySet<HookFeature>;
  disabledSource: SwitchSource;
  unknownFeatures: string[];
}

export interface SwitchSettings {
  MEMSMITH_MODE?: string;
  MEMSMITH_HOOKS_DISABLED?: string;
}

const KNOWN = new Set<string>(HOOK_FEATURES);

// MEMSMITH_MODE used to name an observation profile (`code`, `code--es`), and
// settings.json files written by earlier versions still carry one. Those
// values mean write.
function isLegacyProfile(value: string): boolean {
  return value === 'code' || value.startsWith('code--');
}

// A variable that is present but empty still wins, so a session can clear a
// settings.json default (for example MEMSMITH_HOOKS_DISABLED=).
function pick(env: string | undefined, settings: string | undefined): { raw: string; source: SwitchSource } {
  if (env !== undefined) return { raw: env, source: 'env' };
  if (settings !== undefined && settings.trim() !== '') return { raw: settings, source: 'settings' };
  return { raw: '', source: 'default' };
}

export function resolveFeatureSwitches(settings: SwitchSettings, env: NodeJS.ProcessEnv = process.env): FeatureSwitches {
  const modePick = pick(env.MEMSMITH_MODE, settings.MEMSMITH_MODE);
  const modeValue = modePick.raw.trim().toLowerCase();
  const known = modeValue === '' || modeValue === 'read' || modeValue === 'write' || isLegacyProfile(modeValue);
  const mode: MemoryMode = modeValue === 'read' ? 'read' : 'write';
  const listPick = pick(env.MEMSMITH_HOOKS_DISABLED, settings.MEMSMITH_HOOKS_DISABLED);
  const names = listPick.raw.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  return {
    mode,
    modeSource: mode === 'read' || (modeValue === 'write' && modePick.source === 'env') ? modePick.source : 'default',
    invalidMode: known ? null : modePick.raw.trim(),
    disabled: new Set(names.filter((n): n is HookFeature => KNOWN.has(n))),
    disabledSource: names.length === 0 ? 'default' : listPick.source,
    unknownFeatures: [...new Set(names.filter((n) => !KNOWN.has(n)))],
  };
}

let fileSettings: SwitchSettings | null = null;
const warned = new Set<string>();

export function readSwitchSettings(settingsPath: string = USER_SETTINGS_PATH): SwitchSettings {
  try {
    const flat = readFlatSettings(settingsPath) ?? {};
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return { MEMSMITH_MODE: text(flat.MEMSMITH_MODE), MEMSMITH_HOOKS_DISABLED: text(flat.MEMSMITH_HOOKS_DISABLED) };
  } catch {
    return {};
  }
}

function settingsFile(): SwitchSettings {
  if (fileSettings === null) fileSettings = readSwitchSettings();
  return fileSettings;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn('SETTINGS', message);
}

export function currentFeatureSwitches(env: NodeJS.ProcessEnv = process.env): FeatureSwitches {
  const switches = resolveFeatureSwitches(settingsFile(), env);
  for (const name of switches.unknownFeatures) {
    warnOnce(`feature:${name}`, `MEMSMITH_HOOKS_DISABLED: ignoring unknown feature "${name}". Known features: ${HOOK_FEATURES.join(', ')}`);
  }
  if (switches.invalidMode !== null) {
    warnOnce(`mode:${switches.invalidMode}`, `MEMSMITH_MODE: "${switches.invalidMode}" is not read or write; using write`);
  }
  return switches;
}

export function resetFeatureSwitchesForTesting(): void {
  fileSettings = null;
  warned.clear();
}

export function isFeatureEnabled(feature: HookFeature, switches: FeatureSwitches = currentFeatureSwitches()): boolean {
  if (switches.disabled.has(feature)) return false;
  if (feature === 'capture' || feature === 'summary') {
    return switches.mode === 'write' && !switches.disabled.has('capture');
  }
  return true;
}

export function writesAllowed(switches: FeatureSwitches = currentFeatureSwitches()): boolean {
  return switches.mode === 'write';
}

const SOURCE_LABEL: Record<SwitchSource, string> = {
  env: 'in the environment',
  settings: 'in settings.json',
  default: 'default',
};

export function memoryModeSummary(switches: FeatureSwitches): string | null {
  if (switches.mode === 'write') return null;
  return `read (MEMSMITH_MODE ${SOURCE_LABEL[switches.modeSource]})`;
}

export function switchSourceLabel(source: SwitchSource): string {
  return SOURCE_LABEL[source];
}
