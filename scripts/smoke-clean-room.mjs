#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(process.env.SMOKE_REPO ?? join(import.meta.dirname, '..'));
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const serverPort = process.env.SMOKE_SERVER_PORT ?? '38990';
const pgPort = process.env.SMOKE_PG_PORT ?? '55490';
const deadline = Date.now() + 15 * 60 * 1000;

const home = mkdtempSync(join(tmpdir(), 'memsmith-smoke-'));
const prefix = join(home, 'npm-global');
const memsmith = join(prefix, 'bin', 'memsmith');
const workDir = join(home, 'work');
const stepLogs = join(home, 'step-logs');
mkdirSync(workDir);
mkdirSync(stepLogs);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MEMSMITH_')));
const env = {
  ...inherited,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  MEMSMITH_DATA_DIR: join(home, '.memsmith'),
  MEMSMITH_SERVER_PORT: serverPort,
  MEMSMITH_SERVER_URL: `http://127.0.0.1:${serverPort}`,
  MEMSMITH_LOCAL_PG_PORT: pgPort,
  npm_config_prefix: prefix,
  PATH: `${join(prefix, 'bin')}:${process.env.PATH}`,
};

function remaining(name) {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error(`smoke timed out before: ${name}`);
  return ms;
}

let stepIndex = 0;
function step(name, cmd, args, expectCode = 0) {
  const timeout = remaining(name);
  console.log(`\n▶ ${name}`);
  // A file, not a pipe: a daemon that inherits a pipe would hold spawnSync open until the timeout.
  const logPath = join(stepLogs, `${String(++stepIndex).padStart(2, '0')}-${name.replace(/[^\w-]+/g, '_')}.log`);
  const fd = openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, { cwd: workDir, env, stdio: ['ignore', fd, fd], timeout });
  } finally {
    closeSync(fd);
  }
  const output = readFileSync(logPath, 'utf8');
  process.stdout.write(output);
  if (r.status !== expectCode) throw new Error(`${name}: expected exit ${expectCode}, got ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
  return output;
}

function portFree(port) {
  return new Promise((done) => {
    const s = net.connect({ port: Number(port), host: '127.0.0.1' });
    s.setTimeout(Math.min(5000, remaining(`probe port ${port}`)), () => { s.destroy(); done(false); });
    s.once('connect', () => { s.destroy(); done(false); });
    s.once('error', () => done(true));
  });
}

let failed = false;
try {
  execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: remaining('bun --version') });
  for (const port of [serverPort, pgPort]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is already in use; set SMOKE_SERVER_PORT / SMOKE_PG_PORT`);
  }
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: repo, encoding: 'utf8', timeout: remaining('npm pack') }).trim().split('\n').pop();
  step('install tarball', 'npm', ['install', '-g', join(home, tarball)]);
  step('memsmith install', memsmith, ['install', '--no-auto-start', '--ide', 'claude-code']);
  step('memsmith start', memsmith, ['start']);
  const status = step('memsmith status (running)', memsmith, ['status']);
  if (!status.includes(version)) throw new Error(`status does not report version ${version}`);
  step('memsmith stop --all', memsmith, ['stop', '--all']);
  step('memsmith status (stopped)', memsmith, ['status'], 1);
  for (const port of [serverPort, pgPort]) {
    if (!(await portFree(port))) throw new Error(`port ${port} still has a listener`);
  }
  console.log('\n✓ clean-room smoke passed');
} catch (error) {
  failed = true;
  console.error(`\n✗ ${error.message}`);
  const artifacts = join(repo, 'smoke-artifacts');
  for (const dir of [join(home, '.memsmith', 'logs'), stepLogs]) {
    if (!existsSync(dir)) continue;
    mkdirSync(artifacts, { recursive: true });
    for (const f of readdirSync(dir)) cpSync(join(dir, f), join(artifacts, f), { recursive: true });
  }
} finally {
  if (existsSync(memsmith)) spawnSync(memsmith, ['stop', '--all'], { cwd: workDir, env, stdio: 'ignore', timeout: 60_000 });
  if (!process.env.SMOKE_KEEP_HOME) rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
