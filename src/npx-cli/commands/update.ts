import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { paths } from '../../shared/paths.js';
import { dirname, join } from 'path';
import { styleText } from 'node:util';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { pickProxyVars } from '../install/ollama-setup.js';
import { ensureBun, ensureUv, installPluginDependencies, writeInstallMarker } from '../install/setup-runtime.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import {
  installedPluginsPath,
  installedPluginVersion,
  isPluginInstalled,
  IS_WINDOWS,
  pluginCacheDirectory,
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { defaultLifecycleDeps, resolveServerAddress, runLifecycle } from './lifecycle.js';
import { copyPluginToCache, copyPluginToMarketplace, installMarketplaceDependencies } from './install.js';

const PLUGIN_KEY = 'memsmith@shshalom';
const REEXEC_ENV = 'MEMSMITH_UPDATE_REEXEC';
const USAGE = 'Usage: memsmith update [--force] [--no-self-update]';
const KNOWN_FLAGS = new Set(['--force', '--no-self-update']);
const STOPPED_MARKER = () => join(paths.dataDir(), '.update-stopped-server');

export type ServerState =
  | { kind: 'remote'; baseUrl: string }
  | { kind: 'stopped' }
  | { kind: 'running'; version?: string };

export interface UpdateDeps {
  cliVersion(): string;
  latestPublished(): Promise<string | null>;
  isReexec(): boolean;
  reexecLatest(version: string, argv: string[]): Promise<number>;
  isInstalled(): boolean;
  installedVersion(): string | null;
  cacheReady(version: string): boolean;
  installPluginFiles(version: string): Promise<void>;
  syncRegistry(version: string): number;
  serverStoppedByUpdate(): boolean;
  setServerStoppedByUpdate(stopped: boolean): void;
  serverState(): Promise<ServerState>;
  stopServer(): Promise<number>;
  startServer(): Promise<number>;
  out(line: string): void;
  err(line: string): void;
}

function versionParts(version: string): { core: number[]; prerelease: boolean } {
  const [core, prerelease] = version.trim().replace(/^v/, '').split('-', 2);
  return { core: core.split('.').map(part => Number.parseInt(part, 10) || 0), prerelease: prerelease !== undefined };
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.core.length, b.core.length, 3); i++) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return !a.prerelease && b.prerelease;
}

interface PluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

// Claude Code keeps one entry per scope: a user-wide install plus one per
// project installed locally. A local entry wins inside its project, so every
// entry has to move or that project keeps loading the old plugin.
export function syncInstalledPluginEntries(
  registry: Record<string, unknown>,
  version: string,
  cachePath: string,
  now: string,
): { registry: Record<string, unknown>; changed: number } {
  const cacheRoot = dirname(cachePath);
  const plugins = { ...((registry.plugins as Record<string, unknown> | undefined) ?? {}) };
  const current = Array.isArray(plugins[PLUGIN_KEY]) ? (plugins[PLUGIN_KEY] as PluginEntry[]) : [];
  let changed = 0;
  const next = current.length === 0
    ? [{ scope: 'user', installPath: cachePath, version, installedAt: now, lastUpdated: now }]
    : current.map((entry) => {
      if (entry.version === version && entry.installPath === cachePath) return entry;
      if (typeof entry.installPath === 'string' && dirname(entry.installPath) !== cacheRoot) return entry;
      changed++;
      const { gitCommitSha: _sha, ...rest } = entry;
      return { ...rest, installPath: cachePath, version, lastUpdated: now };
    });
  if (current.length === 0) changed = 1;
  plugins[PLUGIN_KEY] = next;
  return { registry: { ...registry, version: registry.version ?? 2, plugins }, changed };
}

function checkArgs(argv: string[], d: UpdateDeps): number | null {
  if (argv.includes('--help') || argv.includes('-h')) {
    d.out(USAGE);
    return 0;
  }
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      d.err(`Unknown option: ${arg}`);
      d.err(USAGE);
      return 1;
    }
  }
  return null;
}

export async function runUpdate(argv: string[], d: UpdateDeps = defaultUpdateDeps()): Promise<number> {
  const argError = checkArgs(argv, d);
  if (argError !== null) return argError;
  const force = argv.includes('--force');

  if (!d.isInstalled()) {
    d.err('MemSmith is not installed. Run: npx memsmith install');
    return 1;
  }

  const target = d.cliVersion();
  if (!argv.includes('--no-self-update') && !d.isReexec()) {
    const latest = await d.latestPublished();
    if (latest === null) {
      d.out(`Couldn't check npm for a newer version; updating to this CLI's version, ${target}.`);
    } else if (isNewerVersion(latest, target)) {
      d.out(`MemSmith ${latest} is available (this CLI is ${target}). Running memsmith@${latest} update…`);
      const code = await d.reexecLatest(latest, argv);
      if (code !== 0) {
        d.err(`memsmith@${latest} update did not finish (exit ${code}).`);
        d.err(`If npx is unavailable, install the CLI with \`npm install -g memsmith@${latest}\` and run \`memsmith update\`, or run \`memsmith update --no-self-update\` to update to ${target}.`);
      }
      return code;
    }
  }

  const installed = d.installedVersion();
  if (installed && isNewerVersion(installed, target) && !force) {
    d.err(`The installed plugin (${installed}) is newer than this CLI (${target}). Nothing changed.`);
    d.err(`To install ${target} anyway, run: memsmith update --force`);
    return 1;
  }

  // A run that failed after stopping the server leaves it stopped; the next
  // run has to treat it as running so the server comes back.
  const observed = await d.serverState();
  const server: ServerState = observed.kind === 'stopped' && d.serverStoppedByUpdate()
    ? { kind: 'running', version: undefined }
    : observed;
  const replaceFiles = force || installed !== target || !d.cacheReady(target);
  const staleServer = server.kind === 'running' && server.version !== target;

  let registryChanged: number;
  try {
    if (replaceFiles) {
      if (observed.kind === 'running') {
        d.out('Stopping the server…');
        if ((await d.stopServer()) !== 0) {
          d.err('The server did not stop, so the plugin files were not replaced.');
          return 1;
        }
        d.setServerStoppedByUpdate(true);
      }
      d.out(`Installing MemSmith ${target}…`);
      await d.installPluginFiles(target);
    }
    registryChanged = d.syncRegistry(target);
  } catch (error) {
    d.err(`The update failed: ${error instanceof Error ? error.message : String(error)}`);
    const remediation = (error as { remediation?: unknown } | null)?.remediation;
    if (typeof remediation === 'string' && remediation) d.err(remediation);
    if (d.serverStoppedByUpdate()) d.err('The server is stopped. To retry the update and start it again, run: memsmith update --force');
    else d.err('To retry, run: memsmith update --force');
    return 1;
  }
  if (registryChanged > 0) d.out(`Updated ${registryChanged} Claude Code plugin entr${registryChanged === 1 ? 'y' : 'ies'} to ${target}.`);

  let serverLine: string;
  if (server.kind === 'remote') {
    serverLine = `Server: team server at ${server.baseUrl} (not managed by this machine)`;
  } else if (server.kind === 'stopped') {
    serverLine = 'Server: not running. Start it with: memsmith start';
  } else {
    if (staleServer && observed.kind === 'running' && !replaceFiles) {
      d.out(`Restarting the server (it runs ${observed.version ?? 'an unknown version'})…`);
      if ((await d.stopServer()) !== 0) {
        d.err('The server did not stop. Run: memsmith restart');
        return 1;
      }
      d.setServerStoppedByUpdate(true);
    }
    if (replaceFiles || staleServer) {
      d.out('Starting the server…');
      if ((await d.startServer()) !== 0) {
        d.err('The server did not start. Run: memsmith start, or memsmith doctor');
        return 1;
      }
    }
    d.setServerStoppedByUpdate(false);
    const after = await d.serverState();
    const runningVersion = after.kind === 'running' ? after.version : undefined;
    if (runningVersion !== target) {
      d.err(`The server still reports ${runningVersion ?? 'no version'}, not ${target}. Run: memsmith doctor`);
      return 1;
    }
    serverLine = `Server: ${runningVersion}`;
  }

  const nothingChanged = !replaceFiles && registryChanged === 0 && !staleServer;
  d.out(nothingChanged ? `MemSmith ${target} is already up to date.` : `MemSmith updated to ${target}.`);
  d.out(`  Plugin: ${target}`);
  d.out(`  ${serverLine}`);
  if (!nothingChanged) d.out('Run /reload-plugins in Claude Code, or restart it, to load the new plugin.');
  return 0;
}

const NPM_NETWORK_CONFIG = ['npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_registry'];

// sanitizeEnv strips proxy settings, which npm needs to reach the registry.
function pickNpmNetworkConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of NPM_NETWORK_CONFIG) {
    for (const key of [name, name.toUpperCase()]) {
      const value = env[key];
      if (value !== undefined) picked[key] = value;
    }
  }
  return picked;
}

function npmCommand(name: 'npm' | 'npx'): string {
  return IS_WINDOWS ? `${name}.cmd` : name;
}

function cachedPluginVersion(cacheDir: string): string | null {
  try {
    const version = JSON.parse(readFileSync(join(cacheDir, '.claude-plugin', 'plugin.json'), 'utf-8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

export function defaultUpdateDeps(): UpdateDeps {
  const lifecycle = defaultLifecycleDeps();
  const quiet = { ...lifecycle, out: () => {} };
  return {
    cliVersion: () => readPluginVersion(),
    latestPublished: async () => {
      const result = spawnSync(npmCommand('npm'), ['view', 'memsmith@latest', 'version'], {
        encoding: 'utf-8',
        timeout: 20_000,
        env: { ...sanitizeEnv(process.env), ...pickProxyVars(process.env), ...pickNpmNetworkConfig(process.env) },
        shell: IS_WINDOWS,
      });
      const version = result.status === 0 ? result.stdout.trim().split('\n').pop()?.trim() : '';
      return version && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) ? version : null;
    },
    isReexec: () => process.env[REEXEC_ENV] === '1',
    reexecLatest: (version, argv) => new Promise((resolve) => {
      const child = spawn(npmCommand('npx'), ['--yes', `memsmith@${version}`, 'update', ...argv], {
        stdio: 'inherit',
        env: { ...sanitizeEnv(process.env), ...pickProxyVars(process.env), ...pickNpmNetworkConfig(process.env), [REEXEC_ENV]: '1' },
        shell: IS_WINDOWS,
      });
      child.on('error', () => resolve(1));
      child.on('close', (code) => resolve(code ?? 1));
    }),
    isInstalled: () => isPluginInstalled(),
    installedVersion: () => (isPluginInstalled() ? installedPluginVersion(undefined, () => '') || null : null),
    cacheReady: (version) => {
      const cacheDir = pluginCacheDirectory(version);
      return existsSync(join(cacheDir, 'node_modules')) && cachedPluginVersion(cacheDir) === version;
    },
    installPluginFiles: async (version) => {
      copyPluginToCache(version);
      const { bunPath, version: bunVersion } = await ensureBun();
      const { version: uvVersion } = await ensureUv();
      const cacheDir = pluginCacheDirectory(version);
      await installPluginDependencies(cacheDir, bunPath);
      writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
      copyPluginToMarketplace();
      await installMarketplaceDependencies();
    },
    syncRegistry: (version) => {
      const path = installedPluginsPath();
      const { registry, changed } = syncInstalledPluginEntries(
        readJsonSafe<Record<string, unknown>>(path, {}),
        version,
        pluginCacheDirectory(version),
        new Date().toISOString(),
      );
      if (changed > 0) writeJsonFileAtomic(path, registry);
      return changed;
    },
    serverStoppedByUpdate: () => existsSync(STOPPED_MARKER()),
    setServerStoppedByUpdate: (stopped) => {
      if (stopped) {
        mkdirSync(paths.dataDir(), { recursive: true });
        writeFileSync(STOPPED_MARKER(), new Date().toISOString());
      } else {
        rmSync(STOPPED_MARKER(), { force: true });
      }
    },
    serverState: async () => {
      const addr = resolveServerAddress(lifecycle.serverUrl());
      if (addr.remote) return { kind: 'remote', baseUrl: addr.baseUrl };
      const health = await lifecycle.probeHealth(addr.baseUrl);
      return health.reachable ? { kind: 'running', version: health.version } : { kind: 'stopped' };
    },
    stopServer: () => runLifecycle('stop', [], quiet),
    startServer: () => runLifecycle('start', [], quiet),
    out: (line) => console.log(line),
    err: (line) => console.error(styleText('yellow', line)),
  };
}
