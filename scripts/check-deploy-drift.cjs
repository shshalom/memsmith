#!/usr/bin/env node
/**
 * Deploy-drift check.
 *
 * WHY THIS EXISTS — a full session was spent verifying fixes against code that
 * was never running.
 *
 * The server does NOT run from this repo. It runs from the installed marketplace
 * copy:
 *
 *   ~/.claude/plugins/marketplaces/shshalom/plugin/scripts/server-service.cjs
 *
 * `npm run build` writes to <repo>/plugin/. `npm run sync-marketplace` copies
 * that to the installed location. Running only `build` produces a repo bundle
 * that looks correct while the live server keeps executing the previous deploy.
 *
 * Measured cost: six merged fixes (settings 0600, queue priority lanes, convert
 * bootstrap, marker race, credential concurrency, multi-project recovery) were
 * each reported as "verified live" while the running server was a day-old build.
 * Every unit test was honest; every live verification was against stale code.
 * The tell was a startup log line that never appeared no matter how many times
 * the server was restarted.
 *
 * This check makes that state impossible to miss:
 *   1. Source newer than the repo build      -> you forgot `npm run build`
 *   2. Repo build differs from installed copy -> you forgot `sync-marketplace`
 *   3. Installed copy older than the running server's start time -> restart
 *
 * Pure CJS, no compile step, so it can run before tsc and in any hook.
 * Exits non-zero with the exact command to run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALLED_ROOT = path.join(
  os.homedir(), '.claude', 'plugins', 'marketplaces', 'shshalom', 'plugin',
);

/** Built artifacts that must match between repo and installed copy. */
const ARTIFACTS = [
  'scripts/server-service.cjs',
  'scripts/mcp-server.cjs',
  'scripts/transcript-watcher.cjs',
];

/** Source trees whose changes require a rebuild. */
const SOURCE_DIRS = ['src'];

function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) continue;
      try {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* ignore */ }
    }
  };
  walk(dir);
  return newest;
}

function hash(file) {
  try {
    return execSync(`md5 -q ${JSON.stringify(file)}`, { encoding: 'utf-8' }).trim();
  } catch {
    try {
      return execSync(`md5sum ${JSON.stringify(file)}`, { encoding: 'utf-8' }).trim().split(/\s+/)[0];
    } catch { return null; }
  }
}

const problems = [];

// 1. Source newer than the repo build.
const repoBuild = path.join(REPO_ROOT, 'plugin', ARTIFACTS[0]);
if (!fs.existsSync(repoBuild)) {
  problems.push(`repo build missing: plugin/${ARTIFACTS[0]}\n    fix: npm run build`);
} else {
  const buildMtime = fs.statSync(repoBuild).mtimeMs;
  for (const dir of SOURCE_DIRS) {
    const srcMtime = newestMtime(path.join(REPO_ROOT, dir));
    if (srcMtime > buildMtime) {
      const ageMin = Math.round((srcMtime - buildMtime) / 60000);
      problems.push(
        `${dir}/ is ${ageMin} min newer than the build — the bundle does NOT contain your changes\n`
        + `    fix: npm run build-and-sync`,
      );
      break;
    }
  }
}

// 2. Repo build vs installed copy. This is the one that cost a full session:
//    `build` alone leaves the live server on the previous deploy.
if (!fs.existsSync(INSTALLED_ROOT)) {
  // Not installed on this machine — nothing to drift from.
  process.stdout.write('deploy-drift: marketplace not installed; skipping installed-copy comparison\n');
} else {
  for (const rel of ARTIFACTS) {
    const repoFile = path.join(REPO_ROOT, 'plugin', rel);
    const installedFile = path.join(INSTALLED_ROOT, rel);
    if (!fs.existsSync(repoFile)) continue;
    if (!fs.existsSync(installedFile)) {
      problems.push(`installed copy missing: ${rel}\n    fix: npm run sync-marketplace`);
      continue;
    }
    const a = hash(repoFile);
    const b = hash(installedFile);
    if (a && b && a !== b) {
      problems.push(
        `${rel} differs between the repo build and the INSTALLED copy the server runs\n`
        + `    the live server is executing the OLD bundle — merged fixes are not deployed\n`
        + `    fix: npm run sync-marketplace`,
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write('\nDEPLOY DRIFT — the running server is not your code:\n\n');
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write(
    '\nAfter syncing, RESTART the server so it picks up the new bundle:\n'
    + '  node dist/npx-cli/index.js server start   (stop the old pid first)\n\n'
    + 'A merged fix is not a deployed fix. Verifying live behaviour against a\n'
    + 'stale bundle produces confident, false results.\n\n',
  );
  process.exit(1);
}

process.stdout.write('deploy-drift: clean — repo build matches the installed copy\n');
