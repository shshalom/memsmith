#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
const env = {
  ...process.env,
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  MEMSMITH_DATA_DIR: join(home, '.memsmith'),
  MEMSMITH_SERVER_PORT: serverPort,
  MEMSMITH_SERVER_URL: `http://127.0.0.1:${serverPort}`,
  MEMSMITH_LOCAL_PG_PORT: pgPort,
  npm_config_prefix: prefix,
  PATH: `${join(prefix, 'bin')}:${process.env.PATH}`,
};

function step(name, cmd, args, expectCode = 0) {
  if (Date.now() > deadline) throw new Error(`smoke timed out before: ${name}`);
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: deadline - Date.now() });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== expectCode) throw new Error(`${name}: expected exit ${expectCode}, got ${r.status}${r.error ? ` (${r.error.message})` : ''}`);
  return r.stdout ?? '';
}

function portFree(port) {
  return new Promise((done) => {
    const s = net.connect({ port: Number(port), host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); done(false); });
    s.once('error', () => done(true));
  });
}

let failed = false;
try {
  execFileSync('bun', ['--version'], { stdio: 'ignore' });
  for (const port of [serverPort, pgPort]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is already in use; set SMOKE_SERVER_PORT / SMOKE_PG_PORT`);
  }
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop();
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
  const logs = join(home, '.memsmith', 'logs');
  if (existsSync(logs)) {
    mkdirSync(join(repo, 'smoke-artifacts'), { recursive: true });
    for (const f of readdirSync(logs)) cpSync(join(logs, f), join(repo, 'smoke-artifacts', f), { recursive: true });
  }
} finally {
  if (existsSync(memsmith)) spawnSync(memsmith, ['stop', '--all'], { env, stdio: 'ignore', timeout: 60_000 });
  if (!process.env.SMOKE_KEEP_HOME) rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
