// SPDX-License-Identifier: Apache-2.0
//
// A brand-new local project could never mint its identity. session-init opens
// its own Postgres connection via getSharedPostgresPool({requireDatabaseUrl:
// true}), which throws when MEMSMITH_SERVER_DATABASE_URL is unset -- and that
// variable is set by local-runtime INSIDE the server process at boot, never
// written to a file. A hook is a separate short-lived process, so it never sees
// it. Every session logged "identity mint skipped (non-fatal)" and no marker,
// database, or data was ever created.
//
// Nothing about the value is secret or unknowable: the embedded PG address is a
// fixed default (127.0.0.1:55433, user memsmith), and a NEW project only needs
// the BASE database -- whose name is the constant 'postgres', where teams /
// projects / api_keys live. So the hook can derive exactly what it needs.
import { describe, it, expect } from 'bun:test';
import { resolveLocalBaseDatabaseUrl } from '../../../src/services/identity/local-base-dsn.js';

describe('resolveLocalBaseDatabaseUrl', () => {
  it('prefers an explicit MEMSMITH_SERVER_DATABASE_URL when the process has one', () => {
    const explicit = 'postgres://someone:secret@db.example.com:5432/teamdb';
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: explicit })).toBe(explicit);
  });

  it('derives the base DSN from known defaults when the variable is absent', () => {
    const url = resolveLocalBaseDatabaseUrl({});
    expect(url).toBe('postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres');
  });

  it('targets the BASE database, never a per-project one', () => {
    // A new project has no projectId yet, so msp_<id> cannot exist. Account
    // tables (teams/projects/api_keys) live only in the base database anyway.
    const url = new URL(resolveLocalBaseDatabaseUrl({}));
    expect(url.pathname).toBe('/postgres');
    expect(url.pathname).not.toContain('msp_');
  });

  it('honours a custom embedded PG port', () => {
    const url = resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '55444' });
    expect(url).toContain(':55444/');
  });

  it('ignores a non-numeric or non-positive port and falls back to the default', () => {
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: 'abc' })).toContain(':55433/');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '0' })).toContain(':55433/');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_LOCAL_PG_PORT: '-1' })).toContain(':55433/');
  });

  it('treats an empty or whitespace-only variable as absent', () => {
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: '' })).toContain(':55433/postgres');
    expect(resolveLocalBaseDatabaseUrl({ MEMSMITH_SERVER_DATABASE_URL: '   ' })).toContain(':55433/postgres');
  });
});
