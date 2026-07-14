import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { getBunPath } from '../install/setup-runtime.js';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

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

function workerServiceScriptPath(): string {
  return join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs');
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

function spawnBunWorkerCommand(command: string, extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(styleText('red', `Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx memsmith install');
    process.exit(1);
  }

  spawnPlugin(bunPath, [workerScript, command, ...extraArgs]);
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

export function runServerStartCommand(): void {
  spawnBunServerCommand('start');
}

export function runServerStopCommand(): void {
  spawnBunServerCommand('stop');
}

export function runServerRestartCommand(): void {
  spawnBunServerCommand('restart');
}

export function runServerStatusCommand(): void {
  spawnBunServerCommand('status');
}

// Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
// Compose to scale generation horizontally while a single (or multiple)
// HTTP-only server replicas serve writes/reads.
export function runServerWorkerStartCommand(): void {
  spawnBunServerCommand('worker', ['start']);
}

export function runStartCommand(): void {
  spawnBunWorkerCommand('start');
}

export function runStopCommand(): void {
  spawnBunWorkerCommand('stop');
}

export function runRestartCommand(): void {
  spawnBunWorkerCommand('restart');
}

export function runStatusCommand(): void {
  spawnBunWorkerCommand('status');
}

export function runServerApiKeyCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('server', ['api-key', ...extraArgs]);
}

export function runAdoptCommand(extraArgs: string[] = []): void {
  ensureInstalledOrExit();
  const bunPath = resolveBunOrExit();
  const workerScript = workerServiceScriptPath();

  if (!existsSync(workerScript)) {
    console.error(styleText('red', `Worker script not found at: ${workerScript}`));
    console.error('The installation may be corrupted. Try: npx memsmith install');
    process.exit(1);
  }

  const userCwd = process.cwd();
  spawnPlugin(bunPath, [workerScript, 'adopt', '--cwd', userCwd, ...extraArgs]);
}

export function runCleanupCommand(extraArgs: string[] = []): void {
  spawnBunWorkerCommand('cleanup', extraArgs);
}

export async function runSearchCommand(queryParts: string[]): Promise<void> {
  ensureInstalledOrExit();

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(styleText('red', 'Usage: npx memsmith search <query>'));
    process.exit(1);
  }

  // Worker retirement — the old route `/api/search` on the legacy worker is
  // gone. Repoint to the local/server runtime's POST /v1/search, using the
  // same credentials pattern as the opencode-plugin (MEMSMITH_SERVER_URL,
  // MEMSMITH_SERVER_API_KEY, MEMSMITH_SERVER_PROJECT_ID from settings).
  const serverBaseUrl = SettingsDefaultsManager.get('MEMSMITH_SERVER_URL').replace(/\/+$/, '');
  const serverApiKey = SettingsDefaultsManager.get('MEMSMITH_SERVER_API_KEY');
  const serverProjectId = SettingsDefaultsManager.get('MEMSMITH_SERVER_PROJECT_ID');

  if (!serverApiKey || !serverProjectId) {
    console.error(styleText('red', 'MemSmith runtime is not configured.'));
    console.error(`Start it with: ${styleText('bold', 'npx memsmith start')}`);
    process.exit(1);
  }

  const searchUrl = `${serverBaseUrl}/v1/search`;

  let response: Response;
  try {
    response = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serverApiKey}`,
      },
      body: JSON.stringify({ query, projectId: serverProjectId, limit: 20 }),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(styleText('red', 'MemSmith runtime is not running.'));
      console.error(`Start it with: ${styleText('bold', 'npx memsmith start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `Search failed: ${message}`));
    process.exit(1);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      console.error(styleText('red', `Search failed: authentication error (HTTP ${response.status}).`));
      console.error('Re-run the installer to refresh credentials: ' + styleText('bold', 'npx memsmith install'));
      process.exit(1);
    }
    if (response.status === 404) {
      console.error(styleText('red', 'Search endpoint not found. Is the MemSmith runtime running?'));
      console.error(`Try: ${styleText('bold', 'npx memsmith start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `Search failed: HTTP ${response.status}`));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(styleText('red', `Search failed: invalid JSON response (${message})`));
    process.exit(1);
  }

  if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
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
    spawnBunWorkerCommand('transcript', ['watch']);
    return;
  }

  spawnPlugin(bunPath, [transcriptWatcherPath, 'watch'], 'transcript watcher');
}
