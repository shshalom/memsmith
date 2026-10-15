// Installs Bun from the SessionStart start hook. A marketplace install copies
// the plugin but never runs `npx memsmith install`, which is what installs Bun,
// so without this every hook stayed inactive until the user installed Bun by
// hand. Claude Code fires the Setup hook only with --init or --maintenance, so
// it cannot do this. Plain ES2019: bun-runner imports this file, and some hosts
// run hooks under a Node that rejects ?. and ??.
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// The start hook has a 60 s timeout, so the installer gets less than that, and
// a failed attempt waits a day before the next one instead of costing every
// session start the full timeout.
const BUN_INSTALL_TIMEOUT_MS = 50_000;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export function bunInstallCommand(platform) {
  return platform === 'win32'
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash';
}

export function manualBunInstructions(platform) {
  return platform === 'win32'
    ? 'winget install Oven-sh.Bun, or: powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash, or: brew install oven-sh/bun/bun';
}

export function runBunInstaller(command, platform) {
  execSync(command, {
    stdio: 'pipe',
    timeout: BUN_INSTALL_TIMEOUT_MS,
    shell: platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/bash',
    windowsHide: true,
  });
}

function recentAttempt(stampPath, now) {
  try {
    return existsSync(stampPath) && now - statSync(stampPath).mtimeMs < RETRY_AFTER_MS;
  } catch {
    return false;
  }
}

function stampAttempt(stampPath, now) {
  try {
    mkdirSync(dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, `${new Date(now).toISOString()}\n`);
  } catch { /* without the stamp the next launch retries sooner */ }
}

export function ensureBun(options) {
  const findBun = options.findBun;
  const log = options.log;
  const runInstaller = options.runInstaller || runBunInstaller;
  const platform = options.platform || process.platform;
  const disabled = Boolean(options.disabled);
  const skipInstall = Boolean(options.skipInstall);
  const attemptStampPath = options.attemptStampPath || null;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const existing = findBun();
  if (existing) return existing;
  if (disabled) {
    log(`Bun is not installed and MEMSMITH_SKIP_BUN_INSTALL is set. Install it with: ${manualBunInstructions(platform)}`);
    return null;
  }
  if (skipInstall) return null;
  if (attemptStampPath && recentAttempt(attemptStampPath, now)) {
    log(`Bun is not installed, and the last automatic install failed less than a day ago. Install it with: ${manualBunInstructions(platform)}`);
    return null;
  }
  if (attemptStampPath) stampAttempt(attemptStampPath, now);
  log('Bun is not installed; installing it with the official installer (one time, into ~/.bun)...');
  try {
    runInstaller(bunInstallCommand(platform), platform);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    log(`Bun install failed (${reason}). Install it with: ${manualBunInstructions(platform)}`);
    return null;
  }
  const installed = findBun();
  if (installed && attemptStampPath) {
    try { rmSync(attemptStampPath, { force: true }); } catch { /* a stale stamp only delays a later reinstall */ }
  }
  log(installed ? 'Bun installed.' : `Bun install finished, but bun was not found. Install it with: ${manualBunInstructions(platform)}`);
  return installed;
}
