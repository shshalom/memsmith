// SPDX-License-Identifier: Apache-2.0
//
// An isolated run must not read the developer's real MemSmith state.
//
// EmbeddedPostgresManager resolved every path from a hardcoded constant:
//
//   const MEMSMITH_HOME = join(homedir(), '.memsmith');
//
// so MEMSMITH_DATA_DIR — honoured by CredentialStore, the settings loader, and
// the rig's own preflight guard — did nothing here. Observed live: a server
// started with MEMSMITH_DATA_DIR=/tmp/ms-teamtest and MEMSMITH_LOCAL_PG_PORT=55445
// read the DOGFOOD's ~/.memsmith/local-pg.pid, found pid 45889 alive (the
// dogfood's postgres on 55433), logged "embedded PG already running; reusing
// {port=55445}", built a connection string for a port nothing listened on, and
// died. The preflight guard had just passed — it validates the inputs, not what
// the code does with them.
//
// The near miss is the point: dataDir came from the same constant. A path where
// isRunning() returned false instead would have pointed an "isolated" server at
// ~/.memsmith/pgdata — the dogfood's own database.
//
// CredentialStore already fixed exactly this ("every other piece of state
// honours MEMSMITH_DATA_DIR; this file hardcoded homedir()"). This is the same
// bug one layer down.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { embeddedPostgresDefaultPaths } from '../../../src/server/runtime/EmbeddedPostgresManager.js';

let prior: string | undefined;
let dir: string;

beforeEach(() => {
  prior = process.env.MEMSMITH_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'ms-pgiso-'));
});
afterEach(() => {
  if (prior === undefined) delete process.env.MEMSMITH_DATA_DIR;
  else process.env.MEMSMITH_DATA_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('embedded PG paths honour MEMSMITH_DATA_DIR', () => {
  it('puts pgdata and the pid file under the overridden data dir', () => {
    process.env.MEMSMITH_DATA_DIR = dir;
    const paths = embeddedPostgresDefaultPaths();
    expect(paths.dataDir).toBe(join(dir, 'pgdata'));
    expect(paths.pidFile).toBe(join(dir, 'local-pg.pid'));
  });

  it('NEVER points at the real ~/.memsmith when overridden', () => {
    // The assertion that matters. Reading the dogfood's pid file is what made an
    // isolated server believe its own postgres was already running; writing to
    // the dogfood's pgdata would have been far worse.
    process.env.MEMSMITH_DATA_DIR = dir;
    const paths = embeddedPostgresDefaultPaths();
    const real = join(process.env.HOME ?? '', '.memsmith');
    expect(paths.dataDir.startsWith(real)).toBe(false);
    expect(paths.pidFile.startsWith(real)).toBe(false);
  });

  it('resolves per-call, not once at module load', () => {
    // The old constant was evaluated at import time, so anything setting the env
    // var after the first import silently got the default. Two different
    // overrides must yield two different answers within one process.
    process.env.MEMSMITH_DATA_DIR = dir;
    const first = embeddedPostgresDefaultPaths().dataDir;
    const other = mkdtempSync(join(tmpdir(), 'ms-pgiso2-'));
    try {
      process.env.MEMSMITH_DATA_DIR = other;
      expect(embeddedPostgresDefaultPaths().dataDir).not.toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps BINARIES in the shared home — they are a large, reusable download', () => {
    // Deliberately NOT isolated: the postgres binaries are ~100MB and identical
    // for every data dir. Re-downloading them per rig would make an isolated run
    // slow enough that nobody uses one, and they are read-only shared content,
    // not state — nothing an isolated run does can corrupt the dogfood through
    // them.
    process.env.MEMSMITH_DATA_DIR = dir;
    const paths = embeddedPostgresDefaultPaths();
    expect(paths.binariesDir).toContain('.memsmith');
    expect(paths.binariesDir).not.toContain(dir);
  });

  it('falls back to ~/.memsmith when nothing is overridden', () => {
    delete process.env.MEMSMITH_DATA_DIR;
    const paths = embeddedPostgresDefaultPaths();
    expect(paths.dataDir).toContain('.memsmith');
    expect(paths.pidFile).toContain('local-pg.pid');
  });
});
