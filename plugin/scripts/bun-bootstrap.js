// Installs Bun from the plugin's Setup hook. A marketplace install copies the
// plugin but never runs `npx memsmith install`, which is what installs Bun, so
// without this every hook stayed inactive until the user installed Bun by hand.
import { execSync } from 'child_process';

const BUN_INSTALL_TIMEOUT_MS = 120_000;

export function bunInstallCommand(platform) {
  return platform === 'win32'
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
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
    shell: platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash',
    windowsHide: true,
  });
}

export function ensureBun({ findBun, runInstaller = runBunInstaller, log, platform = process.platform, disabled = false }) {
  const existing = findBun();
  if (existing) return existing;
  if (disabled) {
    log(`Bun is not installed and MEMSMITH_SKIP_BUN_INSTALL is set. Install it with: ${manualBunInstructions(platform)}`);
    return null;
  }
  log('Bun is not installed; installing it with the official installer (one time, into ~/.bun)...');
  try {
    runInstaller(bunInstallCommand(platform), platform);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    log(`Bun install failed (${reason}). Install it with: ${manualBunInstructions(platform)}`);
    return null;
  }
  const installed = findBun();
  log(installed ? 'Bun installed.' : `Bun install finished, but bun was not found. Install it with: ${manualBunInstructions(platform)}`);
  return installed;
}
