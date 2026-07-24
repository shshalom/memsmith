// SPDX-License-Identifier: Apache-2.0
//
// Per-project database resolution for local mode. Each project gets its own PG
// database inside the one embedded server; the dogfood keeps 'postgres'. See
// docs/superpowers/specs/2026-07-24-local-database-per-project-design.md.
import type { ProjectMarker } from '../../services/identity/project-identity.js';

export function projectDatabaseName(projectId: string): string {
  return 'msp_' + projectId.replace(/-/g, '');
}

export interface ResolveProjectDatabaseDeps {
  cwd: string;
  readMarker: (cwd: string) => ProjectMarker | null;
  writeName: (cwd: string, name: string) => void;
  // True if the legacy `postgres` DB already contains rows for this project
  // (a pre-db-per-project install, e.g. the dogfood).
  probeHasProjectRows: (projectId: string) => Promise<boolean>;
}

export async function resolveProjectDatabaseName(deps: ResolveProjectDatabaseDeps): Promise<string> {
  const marker = deps.readMarker(deps.cwd);
  if (!marker) {
    // No marker → cannot scope; caller should have minted identity first. Fall
    // back to postgres (legacy behavior) rather than crash the boot.
    return 'postgres';
  }
  if (marker.databaseName && marker.databaseName.length > 0) return marker.databaseName;

  const adopt = (await deps.probeHasProjectRows(marker.projectId)) ? 'postgres' : projectDatabaseName(marker.projectId);
  try { deps.writeName(deps.cwd, adopt); } catch { /* stamp best-effort; re-detect next boot */ }
  return adopt;
}

export async function ensureDatabaseExists(
  adminQuery: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  name: string,
): Promise<void> {
  if (name === 'postgres') return;
  const existing = await adminQuery('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (existing.rows.length > 0) return;
  // CREATE DATABASE cannot be parameterized or run in a txn. `name` is derived
  // from a UUID (msp_<hex>), so it is safe; quote the identifier defensively.
  await adminQuery(`CREATE DATABASE "${name}"`);
}
