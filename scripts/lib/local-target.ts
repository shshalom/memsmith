// SPDX-License-Identifier: Apache-2.0
//
// Resolve the local MemSmith database a project directory writes to, from its
// .memsmith/project.json marker. Shared by the one-off migration scripts so they
// target the same database the running server reads.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readProjectMarker, resolveProjectRoot } from '../../src/services/identity/project-identity.js';
import { projectDatabaseName } from '../../src/server/runtime/resolve-project-database.js';
import { readRecordedAccountDatabase, resolveLocalBaseDatabaseUrl } from '../../src/services/identity/local-base-dsn.js';

export interface LocalTarget {
  root: string;
  teamId: string;
  projectId: string;
  databaseName: string;
  dsn: string;
}

export function resolveLocalTarget(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  readAccountDatabase: () => string | null = readRecordedAccountDatabase,
): LocalTarget {
  const root = resolveProjectRoot(cwd);
  const marker = readProjectMarker(root);
  if (!marker) {
    throw new Error(`no MemSmith project at ${root} — open a Claude Code session there with MemSmith enabled first`);
  }
  if (marker.runtime === 'server') {
    throw new Error(`${root} is a team project; these scripts only write to the local database`);
  }
  // The server routes every project to msp_<id> except the one it booted from,
  // which keeps its stamped database. Writing to a stamp the server does not read
  // would leave the rows invisible.
  const perProject = projectDatabaseName(marker.projectId);
  const databaseName = marker.databaseName ?? perProject;
  if (databaseName !== perProject && databaseName !== readAccountDatabase()) {
    throw new Error(
      `${root} is stamped with database ${databaseName}, but the running server reads this project from ${perProject}`,
    );
  }
  // The base URL's own database is irrelevant; only the server address and
  // credentials are reused.
  const url = new URL(resolveLocalBaseDatabaseUrl({ ...env, MEMSMITH_SERVER_DATABASE_URL: '' }, () => null));
  url.pathname = '/' + databaseName;
  return { root, teamId: marker.teamId, projectId: marker.projectId, databaseName, dsn: url.toString() };
}

// An unset shell variable (`--cwd $DIR`) would otherwise resolve to the current
// directory and walk up to whatever project contains it.
export function requireDirectory(value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error('--cwd needs a project directory');
  const dir = resolve(value);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`--cwd ${dir} is not a directory`);
  return dir;
}
