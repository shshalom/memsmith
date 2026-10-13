// SPDX-License-Identifier: Apache-2.0
//
// A hook is a separate short-lived process, so it never inherits the
// MEMSMITH_SERVER_DATABASE_URL that local-runtime sets inside the server. The
// hook derives the DSN itself so it can mint a new project's identity.
//
// Fresh-install rehearsal (2026-10-07): the server had booted its account
// tables into the first project's msp_<id> database, while hooks assumed
// `postgres`. Every mint failed with `relation "teams" does not exist`, no key
// was ever written, and memory stayed unavailable.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRecordedAccountDatabase,
  resolveLocalBaseDatabaseUrl,
} from '../../../src/services/identity/local-base-dsn.js';

const noServerState = () => null;

describe('resolveLocalBaseDatabaseUrl', () => {
  it('prefers an explicit MEMSMITH_SERVER_DATABASE_URL when the process has one', () => {
    const explicit = 'postgres://someone:secret@db.example.com:5432/teamdb';
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: explicit }, () => 'msp_other')).toBe(explicit);
  });

  it('targets the account database the running server recorded', () => {
    const url = new URL(resolveLocalBaseDatabaseUrl({}, () => 'msp_cadb945ffec2424ebc3a1ff465b5ef71'));
    expect(url.pathname).toBe('/msp_cadb945ffec2424ebc3a1ff465b5ef71');
  });

  it('falls back to postgres when no server has recorded its account database', () => {
    expect(resolveLocalBaseDatabaseUrl({}, noServerState)).toBe('postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres');
  });

  it('honours a custom embedded PG port', () => {
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '55444' }, noServerState)).toContain(':55444/');
  });

  it('ignores a non-numeric or non-positive port and falls back to the default', () => {
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: 'abc' }, noServerState)).toContain(':55433/');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '0' }, noServerState)).toContain(':55433/');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '-1' }, noServerState)).toContain(':55433/');
  });

  it('treats an empty or whitespace-only variable as absent', () => {
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: '' }, noServerState)).toContain(':55433/postgres');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: '   ' }, noServerState)).toContain(':55433/postgres');
  });
});

describe('readRecordedAccountDatabase', () => {
  function withStateFile(content: string, fn: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'ms-runtime-state-'));
    try {
      const path = join(dir, '.server-beta.runtime.json');
      writeFileSync(path, content);
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads the account database from the server runtime state', () => {
    withStateFile(JSON.stringify({ pid: 1, accountDatabase: 'msp_abc123' }), (path) => {
      expect(readRecordedAccountDatabase(path)).toBe('msp_abc123');
    });
  });

  it('returns null for state written by a server that predates the field', () => {
    withStateFile(JSON.stringify({ pid: 1, port: 38879 }), (path) => {
      expect(readRecordedAccountDatabase(path)).toBeNull();
    });
  });

  it('rejects a name that could change the connection URL', () => {
    withStateFile(JSON.stringify({ accountDatabase: 'x@evil.example.com/db' }), (path) => {
      expect(readRecordedAccountDatabase(path)).toBeNull();
    });
  });

  it('returns null when the state file is missing or unreadable', () => {
    expect(readRecordedAccountDatabase(join(tmpdir(), 'ms-no-such-dir', 'state.json'))).toBeNull();
    withStateFile('{not json', (path) => {
      expect(readRecordedAccountDatabase(path)).toBeNull();
    });
  });
});
