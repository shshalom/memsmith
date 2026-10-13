import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { readFlatSettings } from './settings.js';

export interface ServerUrlSource {
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
}

export class ServerUrlError extends Error {}

export function resolveServerUrl({ settingsPath = USER_SETTINGS_PATH, env = process.env }: ServerUrlSource = {}): string {
  if (env.MEMSMITH_SERVER_URL) return env.MEMSMITH_SERVER_URL;

  let settings: Record<string, unknown> | null;
  try {
    settings = readFlatSettings(settingsPath);
  } catch (error) {
    throw new ServerUrlError(`Cannot read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fromFile = settings?.MEMSMITH_SERVER_URL;
  if (typeof fromFile === 'string' && fromFile) return fromFile;
  return SettingsDefaultsManager.getAllDefaults().MEMSMITH_SERVER_URL;
}
