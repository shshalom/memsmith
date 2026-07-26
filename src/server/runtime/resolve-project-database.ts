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
  // True if `name` exists on the server. Optional: when omitted, a stamped
  // marker is trusted as-is (pre-repair behaviour).
  databaseExists?: (name: string) => Promise<boolean>;
}

// A stamped marker normally wins outright — that is what makes resolution cheap
// and stable. But the stamp is a one-shot decision, so a wrong one is permanent
// and silent: it short-circuits the adopt-legacy probe below, and the runtime
// then CREATEs the named database empty and boots against it while the real
// rows sit unreferenced in `postgres`. That is a data-visibility failure, not a
// crash, so nothing surfaces it.
//
// Repair exactly that case, and only it: an msp_ stamp naming a database that
// does not exist, while `postgres` still holds rows for this project. Anything
// ambiguous keeps the stamp — a missing DB with no legacy rows is just a new
// project that has not been provisioned yet.
async function repairStaleStamp(
  deps: ResolveProjectDatabaseDeps,
  projectId: string,
  stamped: string,
): Promise<string> {
  // A `postgres` stamp is already the legacy answer; never second-guess it.
  if (stamped === 'postgres' || !deps.databaseExists) return stamped;

  try {
    if (await deps.databaseExists(stamped)) return stamped;
    if (!(await deps.probeHasProjectRows(projectId))) return stamped;
  } catch {
    // Probe failure is not evidence of anything. Trusting the stamp preserves
    // existing behaviour; re-adopting on an error could send a healthy
    // per-project install to the wrong database.
    return stamped;
  }

  try { deps.writeName(deps.cwd, 'postgres'); } catch { /* best-effort; re-detect next boot */ }
  return 'postgres';
}

export async function resolveProjectDatabaseName(deps: ResolveProjectDatabaseDeps): Promise<string> {
  const marker = deps.readMarker(deps.cwd);
  if (!marker) {
    // No marker → cannot scope; caller should have minted identity first. Fall
    // back to postgres (legacy behavior) rather than crash the boot.
    return 'postgres';
  }
  if (marker.databaseName && marker.databaseName.length > 0) {
    return repairStaleStamp(deps, marker.projectId, marker.databaseName);
  }

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
