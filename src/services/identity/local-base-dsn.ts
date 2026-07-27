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
// are fixed defaults (see EmbeddedPostgresManager), and a project that does not
// exist yet needs only the BASE database: teams, projects and api_keys live
// there, and the per-project msp_<id> database cannot be named until the
// identity being minted exists.
//
// Scope note: this is the LOCAL runtime's base DSN. Team/server installs always
// set MEMSMITH_SERVER_DATABASE_URL explicitly, and the first branch returns it
// untouched, so this never silently points a team install at a local database.

const DEFAULT_LOCAL_PG_PORT = 55433;
const LOCAL_PG_USER = 'memsmith';
const LOCAL_PG_PASSWORD = 'memsmith-local';
// Account tables (teams, projects, api_keys) live only in the base database.
const BASE_DATABASE = 'postgres';

export function resolveLocalBaseDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MEMSMITH_SERVER_DATABASE_URL?.trim();
  if (explicit) return explicit;

  const parsed = Number.parseInt(env.MEMSMITH_LOCAL_PG_PORT ?? '', 10);
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_PG_PORT;
  return `postgres://${LOCAL_PG_USER}:${LOCAL_PG_PASSWORD}@127.0.0.1:${port}/${BASE_DATABASE}`;
}
