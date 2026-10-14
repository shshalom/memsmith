import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// A marketplace install copies the plugin but skips the installer. The server
// then writes settings.json from its own defaults on first start, and marks
// setup pending. An npx install writes settings.json before the server ever
// runs, so existing installs never carry the pending marker and are never asked.
export const SETUP_PENDING_MARKER = '.setup-pending';
export const SETUP_COMPLETE_MARKER = '.setup-complete';
const PROVIDER_KEYS = ['MEMSMITH_SERVER_PROVIDER', 'MEMSMITH_PROVIDER'];

export interface SetupState {
  pending: boolean;
  complete: boolean;
  rawSettings: Record<string, unknown> | null;
  env: Record<string, string | undefined>;
}

export function isSetupNeeded(state: SetupState): boolean {
  if (!state.pending || state.complete) return false;
  if (state.env.MEMSMITH_SERVER_PROVIDER?.trim()) return false;
  return !PROVIDER_KEYS.some((key) => {
    const value = state.rawSettings?.[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

export function writeSetupPending(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SETUP_PENDING_MARKER), `${new Date().toISOString()}\n`);
}

export function writeSetupComplete(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SETUP_COMPLETE_MARKER), `${new Date().toISOString()}\n`);
  rmSync(join(dataDir, SETUP_PENDING_MARKER), { force: true });
}

export function readSetupMarkers(dataDir: string): { pending: boolean; complete: boolean } {
  return {
    pending: existsSync(join(dataDir, SETUP_PENDING_MARKER)),
    complete: existsSync(join(dataDir, SETUP_COMPLETE_MARKER)),
  };
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
  '2. For Ollama, ask whether to install or start Ollama and download the model now. Then run the command below',
  '   in the background; the download can take several minutes, and memory is paused until it finishes:',
  '   npx --yes memsmith@latest install --ide claude-code --provider ollama --setup-ollama',
  '   Leave out --setup-ollama if the user wants to set up Ollama themselves.',
  '3. For Claude, Gemini, or OpenRouter, run:',
  '   npx --yes memsmith@latest install --ide claude-code --provider <claude|gemini|openrouter>',
  '   Never ask for the API key in chat. Tell the user to add it by running `npx memsmith install --provider <id>`',
  '   in their own terminal, which prompts for the key.',
  '4. When the install command has finished, run `npx --yes memsmith@latest restart`, and tell the user to',
  '   restart Claude Code.',
  'If the user wants to skip the questions, run the Ollama command without --setup-ollama to keep the defaults.',
].join('\n');
