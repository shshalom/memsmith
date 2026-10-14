import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// A marketplace install copies the plugin but skips the installer, so nobody
// chose a generation provider. Installers before the marker existed always
// wrote a provider key to settings.json, and the server's own defaults never
// do, which keeps existing installs from being asked again.
export const SETUP_MARKER = '.setup-complete';
const PROVIDER_KEYS = ['MEMSMITH_SERVER_PROVIDER', 'MEMSMITH_PROVIDER'];

export function isSetupComplete(
  rawSettings: Record<string, unknown> | null,
  env: Record<string, string | undefined>,
  markerExists: boolean,
): boolean {
  if (markerExists) return true;
  if (env.MEMSMITH_SERVER_PROVIDER?.trim()) return true;
  return PROVIDER_KEYS.some((key) => {
    const value = rawSettings?.[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

export function setupMarkerPath(dataDir: string): string {
  return join(dataDir, SETUP_MARKER);
}

export function writeSetupMarker(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(setupMarkerPath(dataDir), `${new Date().toISOString()}\n`);
}

export function markerExists(dataDir: string): boolean {
  return existsSync(setupMarkerPath(dataDir));
}

export const MARKETPLACE_SETUP_USER_NOTICE =
  "MemSmith's setup isn't finished: it was installed from the plugin marketplace, which skips the installer. " +
  'Claude will ask you a few setup questions. To do it yourself instead, run: npx memsmith install';

export const MARKETPLACE_SETUP_DIRECTIVE = [
  'MEMSMITH SETUP NOT FINISHED: MemSmith was installed from the Claude Code plugin marketplace, which copies',
  "the plugin but skips the installer's questions. Before other work, tell the user and finish setup here:",
  '1. Ask which generation provider turns sessions into memories:',
  '   - Ollama (recommended): local and private, no API key; downloads a model of about 9 GB (qwen2.5:14b).',
  '   - Claude, Gemini, or OpenRouter: needs an API key.',
  '2. For Ollama, ask whether to install or start Ollama and download the model now. Then run, in the',
  '   background because the download can take several minutes:',
  '   npx --yes memsmith@latest install --ide claude-code --provider ollama --setup-ollama',
  '   Leave out --setup-ollama if the user wants to set up Ollama themselves.',
  '3. For Claude, Gemini, or OpenRouter, run:',
  '   npx --yes memsmith@latest install --ide claude-code --provider <claude|gemini|openrouter>',
  '   Never ask for the API key in chat. Tell the user to add it by running `npx memsmith install --provider <id>`',
  '   in their own terminal, which prompts for the key.',
  '4. Then run `npx --yes memsmith@latest restart`, and tell the user to restart Claude Code.',
  'If the user wants to skip the questions, run the Ollama command without --setup-ollama to keep the defaults.',
].join('\n');
