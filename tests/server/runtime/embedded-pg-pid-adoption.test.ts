// SPDX-License-Identifier: Apache-2.0
//
// The embedded PG pid file used to record the SERVER's pid. Postgres outlives
// the server, so after a server restart that record went stale, the reuse
// check failed, the stale file was unlinked, and the boot then refused to
// start -- the still-running postgres looked like a foreign process squatting
// on the port. Recovering required hand-writing the pid file.
//
// The pid file must therefore track POSTGRES, and a stale record must be
// re-adopted from postmaster.pid rather than treated as foreign.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EmbeddedPostgresManager } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

let root: string;
let dataDir: string;
let pidFile: string;

// A pid that is alive for the duration of the test: our own process.
const ALIVE = process.pid;
// A pid that is almost certainly dead. PID 1 is alive but not ours; use a high
// unlikely value instead and assert liveness is what drives the behaviour.
const DEAD = 2147483646;

function manager(): EmbeddedPostgresManager {
  return new EmbeddedPostgresManager({
    paths: { binariesDir: join(root, 'bin'), dataDir, pidFile },
  } as never);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ms-pgpid-'));
  dataDir = join(root, 'pgdata');
  pidFile = join(root, 'local-pg.pid');
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('EmbeddedPostgresManager pid adoption', () => {
  it('re-adopts a live postgres when our pid record is stale', () => {
    // The exact failure that broke the dogfood restart: server pid recorded,
    // server died, postgres still up.
    writeFileSync(pidFile, String(DEAD), 'utf8');
    writeFileSync(join(dataDir, 'postmaster.pid'), `${ALIVE}\n${dataDir}\n`, 'utf8');

    expect(manager().isRunning()).toBe(true);
  });

  it('reports not running when neither the record nor postmaster.pid is alive', () => {
    writeFileSync(pidFile, String(DEAD), 'utf8');
    writeFileSync(join(dataDir, 'postmaster.pid'), `${DEAD}\n${dataDir}\n`, 'utf8');

    expect(manager().isRunning()).toBe(false);
  });

  it('reports not running when there is no pid file at all', () => {
    expect(existsSync(pidFile)).toBe(false);
    expect(manager().isRunning()).toBe(false);
  });

  it('still trusts a live pid record without consulting postmaster.pid', () => {
    writeFileSync(pidFile, String(ALIVE), 'utf8');
    // no postmaster.pid written on purpose
    expect(manager().isRunning()).toBe(true);
  });

  it('tolerates a malformed postmaster.pid', () => {
    writeFileSync(pidFile, String(DEAD), 'utf8');
    writeFileSync(join(dataDir, 'postmaster.pid'), 'not-a-pid\n', 'utf8');

    expect(manager().isRunning()).toBe(false);
  });

  it('reads only the first line of postmaster.pid', () => {
    // postmaster.pid is multi-line: pid, data dir, start time, port, ...
    writeFileSync(pidFile, String(DEAD), 'utf8');
    writeFileSync(join(dataDir, 'postmaster.pid'), `${ALIVE}\n${dataDir}\n1785000000\n55433\n`, 'utf8');

    expect(manager().isRunning()).toBe(true);
    // and the stale record is what triggered adoption, not a rewrite
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(DEAD));
  });
});
