// SPDX-License-Identifier: Apache-2.0
//
// Derive the local embedded-Postgres BASE connection string.
//
// local-runtime sets MEMSMITH_SERVER_DATABASE_URL via process.env inside the
// SERVER process at boot; it is never written to a file. Hooks are separate
// short-lived processes, so they never inherit it -- which meant session-init
// could never mint a new project's identity and every fresh local project came
// up with no marker, no database, and no memory.
//
// None of the value is secret. The embedded server's address and credentials
// are fixed defaults (see EmbeddedPostgresManager).
//
// The account tables (teams, projects, api_keys) live in whatever database the
// server booted on: `postgres` on the legacy layout, the first project's
// msp_<id> database on a fresh install. The running server records the name in
// its runtime state. Before that state exists (the first hooks of a fresh
// install race the server's boot) the mint falls back to `postgres`, fails, and
// is retried by the next hook once the server has written its state.
//
// Scope note: this is the LOCAL runtime's base DSN. Team/server installs always
// set MEMSMITH_SERVER_DATABASE_URL explicitly, and the first branch returns it
// untouched, so this never silently points a team install at a local database.

import { existsSync, readFileSync } from 'fs';
import { paths } from '../../shared/paths.js';

const DEFAULT_LOCAL_PG_PORT = 55433;
const LOCAL_PG_USER = 'memsmith';
const LOCAL_PG_PASSWORD = 'memsmith-local';
const FALLBACK_ACCOUNT_DATABASE = 'postgres';
const DATABASE_NAME = /^[A-Za-z0-9_]{1,63}$/;

export function readRecordedAccountDatabase(runtimeStatePath: string = paths.serverRuntime()): string | null {
  try {
    if (!existsSync(runtimeStatePath)) return null;
    const name = (JSON.parse(readFileSync(runtimeStatePath, 'utf-8')) as { accountDatabase?: unknown }).accountDatabase;
    return typeof name === 'string' && DATABASE_NAME.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function resolveLocalBaseDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  readAccountDatabase: () => string | null = readRecordedAccountDatabase,
): string {
  const explicit = env.MEMSMITH_SERVER_DATABASE_URL?.trim();
  if (explicit) return explicit;

  const parsed = Number.parseInt(env.MEMSMITH_LOCAL_PG_PORT ?? '', 10);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_PG_PORT;
  const database = readAccountDatabase() ?? FALLBACK_ACCOUNT_DATABASE;
  return `postgres://${LOCAL_PG_USER}:${LOCAL_PG_PASSWORD}@127.0.0.1:${port}/${database}`;
}
