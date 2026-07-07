import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  claudeSettingsPath,
  installedPluginsPath,
  isPluginInstalled,
  knownMarketplacesPath,
  marketplaceDirectory,
  pluginsDirectory,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { readFlatSettings } from '../utils/settings.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import {
  normalizeRuntimeFlag,
  SERVER_RUNTIME_SETTINGS_KEYS,
  type InstallRuntimeId,
} from './server-runtime-setup.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';

// #2568 — read the runtime the operator installed so uninstall can dispatch to
// the matching teardown. The worker path is the default and is unchanged: only
// when the recorded runtime is the server runtime do we run the extra teardown.
function readSelectedRuntime(): InstallRuntimeId {
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    return normalizeRuntimeFlag(settings.MEMSMITH_RUNTIME) ?? 'worker';
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn('[uninstall] Could not read selected runtime from settings, defaulting to worker:', err);
    return 'worker';
  }
}

function clearServerRuntimeSettings(keys: readonly string[]): void {
  let flat: Record<string, unknown> | null;
  try {
    flat = readFlatSettings(USER_SETTINGS_PATH);
  } catch (error: unknown) {
    console.warn('[uninstall] Could not read settings for server runtime cleanup:', error instanceof Error ? error.message : String(error));
    return;
  }
  if (!flat) return;
  let changed = false;
  for (const key of keys) {
    if (key in flat) {
      delete flat[key];
      changed = true;
    }
  }
  if (changed) {
    try {
      writeFileSync(USER_SETTINGS_PATH, JSON.stringify(flat, null, 2), 'utf-8');
    } catch (error: unknown) {
      console.warn('[uninstall] Could not write settings during server runtime cleanup:', error instanceof Error ? error.message : String(error));
    }
  }
}

function removeMarketplaceDirectory(): boolean {
  const marketplaceDir = marketplaceDirectory();
  if (existsSync(marketplaceDir)) {
    rmSync(marketplaceDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeCacheDirectory(): boolean {
  const cacheDirectory = join(pluginsDirectory(), 'cache', 'shshalom', 'memsmith');
  if (existsSync(cacheDirectory)) {
    rmSync(cacheDirectory, { recursive: true, force: true });
    return true;
  }
  return false;
}

function removeFromKnownMarketplaces(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});
  if (knownMarketplaces['shshalom']) {
    delete knownMarketplaces['shshalom'];
    writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
  }
}

function removeFromInstalledPlugins(): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});
  if (installedPlugins.plugins?.['memsmith@shshalom']) {
    delete installedPlugins.plugins['memsmith@shshalom'];
    writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
  }
}

function stripLegacyMemSmithAlias(): void {
  const home = homedir();
  const candidateFiles = [
    join(home, '.bashrc'),
    join(home, '.zshrc'),
    join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ];

  const aliasLineRegex = /^\s*alias\s+memsmith\s*=/;

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${filePath}:`, error instanceof Error ? error.message : String(error));
      continue;
    }
    const lines = content.split('\n');
    const filtered = lines.filter((line) => !aliasLineRegex.test(line));
    if (filtered.length === lines.length) continue; 
    try {
      writeFileSync(filePath, filtered.join('\n'));
      console.error(`Removed legacy memsmith alias from ${filePath}`);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not rewrite ${filePath}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export function removeFromClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  let dirty = false;

  if (settings.enabledPlugins?.['memsmith@shshalom'] !== undefined) {
    delete settings.enabledPlugins['memsmith@shshalom'];
    dirty = true;
  }

  // Symmetric counterpart to disableClaudeAutoMemory() in install.ts. The
  // installer sets env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1" to suppress
  // Claude Code's built-in auto-memory; on uninstall we restore the host
  // CLI's default behavior by removing that key. The value-equality guard
  // (=== '1') ensures we only strip the specific token the installer wrote
  // — if a user had pre-set this key to something else (e.g. '0' to force
  // auto-memory on), or to '1' themselves before installing memsmith,
  // their intent is preserved. The installer's own no-op-when-already-'1'
  // path means the worst case is leaving behind a value memsmith would
  // have written anyway. Any other env entries the user added themselves
  // (ANTHROPIC_AUTH_TOKEN, AWS_REGION, etc.) are preserved. If the env
  // block becomes empty as a result, the block itself is dropped to keep
  // settings.json tidy.
  if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
    if (
      Object.prototype.hasOwnProperty.call(settings.env, 'CLAUDE_CODE_DISABLE_AUTO_MEMORY') &&
      settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1'
    ) {
      delete settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
      dirty = true;
      if (Object.keys(settings.env).length === 0) {
        delete settings.env;
      }
    }
  }

  if (dirty) {
    writeJsonFileAtomic(claudeSettingsPath(), settings);
  }
}

function removeStrayMemSmithPaths(): number {
  const home = homedir();
  let removedCount = 0;

  const npxRoot = join(home, '.npm', '_npx');
  if (existsSync(npxRoot)) {
    let hashDirs: string[] = [];
    try {
      hashDirs = readdirSync(npxRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${npxRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const hashDir of hashDirs) {
      const candidate = join(npxRoot, hashDir, 'node_modules', 'memsmith');
      if (!existsSync(candidate)) continue;
      try {
        rmSync(candidate, { recursive: true, force: true });
        removedCount++;
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not remove ${candidate}:`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  const cacheRoot = join(home, '.cache', 'claude-cli-nodejs');
  if (existsSync(cacheRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(cacheRoot);
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not read ${cacheRoot}:`, error instanceof Error ? error.message : String(error));
    }
    for (const projectDir of projectDirs) {
      const projectPath = join(cacheRoot, projectDir);
      let logEntries: string[] = [];
      try {
        logEntries = readdirSync(projectPath);
      } catch (error: unknown) {
        console.warn(`[uninstall] Could not read ${projectPath}:`, error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const entry of logEntries) {
        if (!entry.startsWith('mcp-logs-plugin-memsmith-')) continue;
        const logPath = join(projectPath, entry);
        try {
          rmSync(logPath, { recursive: true, force: true });
          removedCount++;
        } catch (error: unknown) {
          console.warn(`[uninstall] Could not remove ${logPath}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  const pluginDataDir = join(home, '.claude', 'plugins', 'data', 'memsmith-shshalom');
  if (existsSync(pluginDataDir)) {
    try {
      rmSync(pluginDataDir, { recursive: true, force: true });
      removedCount++;
    } catch (error: unknown) {
      console.warn(`[uninstall] Could not remove ${pluginDataDir}:`, error instanceof Error ? error.message : String(error));
    }
  }

  return removedCount;
}

export async function runUninstallCommand(): Promise<void> {
  p.intro(styleText(['bgRed', 'white'], ' memsmith uninstall '));

  if (!isPluginInstalled()) {
    p.log.warn('memsmith does not appear to be installed.');

    if (process.stdin.isTTY) {
      const shouldCleanup = await p.confirm({
        message: 'Clean up any remaining registration data anyway?',
        initialValue: false,
      });

      if (p.isCancel(shouldCleanup) || !shouldCleanup) {
        p.outro('Nothing to do.');
        return;
      }
    } else {
      p.outro('Nothing to do.');
      return;
    }
  } else if (process.stdin.isTTY) {
    const shouldContinue = await p.confirm({
      message: 'Are you sure you want to uninstall memsmith?',
      initialValue: false,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel('Uninstall cancelled.');
      return;
    }
  }

  const workerPort = SettingsDefaultsManager.get('MEMSMITH_WORKER_PORT');
  try {
    const result = await shutdownWorkerAndWait(workerPort, 10000);
    if (result.workerWasRunning) {
      p.log.info('Worker service stopped.');
    }
  } catch (error: unknown) {
    console.warn('[uninstall] Worker shutdown attempt failed:', error instanceof Error ? error.message : String(error));
  }

  // #2568 — server-runtime teardown. Gated on the installed/selected runtime so
  // the worker uninstall path is completely unchanged. The bundled Docker
  // compose stack lives under the marketplace dir; if it's present we treat the
  // stack as locally managed and instruct teardown (the actual `docker compose
  // down -v` is an operator/CI side effect, not run from this Node process).
  const selectedRuntime = readSelectedRuntime();
  if (selectedRuntime === 'server') {
    if (existsSync(join(marketplaceDirectory(), 'docker-compose.yml'))) {
      p.log.info(
        'Server runtime detected. Tear down the bundled stack with '
          + '`docker compose down -v --remove-orphans` (stops + removes pg + redis/valkey).',
      );
    } else {
      p.log.info('Server runtime detected (externally managed stack — leaving Docker/pg/redis untouched).');
    }
    clearServerRuntimeSettings(SERVER_RUNTIME_SETTINGS_KEYS);
    p.log.info('Server runtime settings cleared from ~/.memsmith/settings.json.');
  }

  await p.tasks([
    {
      title: 'Removing marketplace directory',
      task: async () => {
        const removed = removeMarketplaceDirectory();
        return removed
          ? `Marketplace directory removed ${styleText('green', 'OK')}`
          : `Marketplace directory not found ${styleText('dim', 'skipped')}`;
      },
    },
    {
      title: 'Removing cache directory',
      task: async () => {
        const removed = removeCacheDirectory();
        return removed
          ? `Cache directory removed ${styleText('green', 'OK')}`
          : `Cache directory not found ${styleText('dim', 'skipped')}`;
      },
    },
    {
      title: 'Removing marketplace registration',
      task: async () => {
        removeFromKnownMarketplaces();
        return `Marketplace registration removed ${styleText('green', 'OK')}`;
      },
    },
    {
      title: 'Removing plugin registration',
      task: async () => {
        removeFromInstalledPlugins();
        return `Plugin registration removed ${styleText('green', 'OK')}`;
      },
    },
    {
      title: 'Removing from Claude settings',
      task: async () => {
        removeFromClaudeSettings();
        return `Claude settings updated ${styleText('green', 'OK')}`;
      },
    },
    {
      title: 'Removing legacy memsmith shell alias',
      task: async () => {
        stripLegacyMemSmithAlias();
        return `Legacy alias check complete ${styleText('green', 'OK')}`;
      },
    },
    {
      title: 'Removing stray memsmith caches and logs',
      task: async () => {
        const removed = removeStrayMemSmithPaths();
        return removed > 0
          ? `Stray paths removed: ${removed} ${styleText('green', 'OK')}`
          : `No stray paths found ${styleText('dim', 'skipped')}`;
      },
    },
  ]);

  const ideCleanups: Array<{ label: string; fn: () => Promise<number> | number }> = [
    { label: 'Windsurf hooks', fn: async () => {
      const { uninstallWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
      return uninstallWindsurfHooks();
    }},
    { label: 'OpenCode plugin', fn: async () => {
      const { uninstallOpenCodePlugin } = await import('../../services/integrations/OpenCodeInstaller.js');
      return uninstallOpenCodePlugin();
    }},
    { label: 'OpenClaw plugin', fn: async () => {
      const { uninstallOpenClawPlugin } = await import('../../services/integrations/OpenClawInstaller.js');
      return uninstallOpenClawPlugin();
    }},
    { label: 'Codex CLI', fn: async () => {
      const { uninstallCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
      return uninstallCodexCli();
    }},
    { label: 'Antigravity CLI hooks + MCP', fn: async () => {
      const { uninstallAntigravityCliHooks } = await import('../../services/integrations/AntigravityCliHooksInstaller.js');
      return uninstallAntigravityCliHooks();
    }},
  ];

  for (const { label, fn } of ideCleanups) {
    try {
      const result = await fn();
      if (result === 0) {
        p.log.info(`${label}: removed.`);
      }
    } catch (error: unknown) {
      console.warn(`[uninstall] ${label} cleanup failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  p.note(
    [
      `Your data directory at ${styleText('cyan', '~/.memsmith')} was preserved.`,
      'To remove it manually: rm -rf ~/.memsmith',
    ].join('\n'),
    'Note',
  );

  // Capture BEFORE the data dir note becomes stale advice: consent and the
  // install ID still live in ~/.memsmith, which uninstall preserves.
  await captureCliEvent('uninstall_completed', {}, { person: true });

  p.outro(styleText('green', 'memsmith has been uninstalled.'));
}
