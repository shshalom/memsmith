import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { getBunPath } from '../install/setup-runtime.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';

function ensureInstalledOrExit(): void {
  if (!isPluginInstalled()) {
    console.error(styleText('red', 'memsmith is not installed.'));
    console.error(`Run: ${styleText('bold', 'npx memsmith install')}`);
    process.exit(1);
  }
}

function resolveBunOrExit(): string {
  const bunPath = getBunPath();
  if (!bunPath) {
    console.error(styleText('red', 'Bun not found.'));
    console.error('Install Bun: https://bun.sh');
    console.error('After installation, restart your terminal.');
    process.exit(1);
  }
  return bunPath;
}

function serverServiceScriptPath(): string {
  // Plan §1c line 149: prefer the renamed `server-service.cjs`, but fall
  // back to the legacy `server-beta-service.cjs` for installed plugin
  // caches that pre-date the rename (forced reinstall not required).
  const scriptsDir = join(marketplaceDirectory(), 'plugin', 'scripts');
  const renamed = join(scriptsDir, 'server-service.cjs');
  if (existsSync(renamed)) {
    return renamed;
  }
  return join(scriptsDir, 'server-beta-service.cjs');
}

/**
 * Spawn a plugin .cjs script under Bun with inherited stdio, exiting this
 * process with the child's exit code. `args[0]` is the script path. Sanitizes
 * host CLI bleed-through and Anthropic credentials before launch; credentials
 * are re-read from ~/.memsmith/.env at SDK spawn time (#2357 / #2375).
 */
function spawnPlugin(bunPath: string, args: string[], startFailureLabel = 'Bun'): void {
  const child = spawnHidden(bunPath, args, {
    stdio: 'inherit',
    cwd: marketplaceDirectory(),
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(styleText('red', `Failed to start ${startFailureLabel}: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

function spawnBunServerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const serverScript = serverServiceScriptPath();

  if (!existsSync(serverScript)) {
    console.error(styleText('red', `Server script not found at: ${serverScript}`));
    console.error('The installation may be corrupted. Try: npx memsmith install');
    process.exit(1);
  }

  spawnPlugin(bunPath, [serverScript, command, ...extraArgs]);
}

// Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
// Compose to scale generation horizontally while a single (or multiple)
// HTTP-only server replicas serve writes/reads.
export function runServerWorkerStartCommand(): void {
  spawnBunServerCommand('worker', ['start']);
}

export function serverApiKeyArgs(extraArgs: string[]): string[] {
  return ['server', 'api-key', ...extraArgs];
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  const [command, ...rest] = serverApiKeyArgs(extraArgs);
  spawnBunServerCommand(command, rest);
}

// adopt and cleanup were subcommands of the retired worker script.
export function runUnavailableCommand(command: string): never {
  console.error(`memsmith ${command} is not available in this version.`);
  process.exit(1);
}

export function runTranscriptWatchCommand(): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();

  const transcriptWatcherPath = join(
    marketplaceDirectory(),
    'plugin',
    'scripts',
    'transcript-watcher.cjs',
  );

  if (!existsSync(transcriptWatcherPath)) {
    console.error(styleText('red', `Transcript watcher not found at: ${transcriptWatcherPath}`));
    console.error('The installation may be corrupted. Try: npx memsmith install');
    process.exit(1);
  }

  spawnPlugin(bunPath, [transcriptWatcherPath, 'watch'], 'transcript watcher');
}
