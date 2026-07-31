// SPDX-License-Identifier: Apache-2.0
//
// Run the recovery sweeps across EVERY project database, not just the base one.
//
// The stranding fixes (drain, stale-lock reclaim, transient-failure reclaim,
// session reclaim, embedding backfill) were written when all projects shared one
// database. They each take a single pool, and startup passed them the BASE pool.
//
// The per-project database split (`msp_<projectId-hex>`) then made every one of
// them partial without changing a line: they still ran, still logged success,
// and silently covered only the base project — the dogfood. Every other project
// stranded in total silence.
//
// Measured on a fresh install (ms-p3-run2): 26 agent_events captured, 27 jobs
// created, 1 completed, 26 stuck in 'queued' with nothing on any code path able
// to see them. The only observations that appeared were a memory_gap and a
// user_note — both DIRECT inserts that bypass generation entirely, which is why
// the project looked half-alive rather than broken.
//
// This is worse than the original stranding bug it descends from: that was a
// one-time backlog, this affects every project the user creates from now on.

/** Minimal pool shape these sweeps need. */
export interface RecoveryQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ProjectTarget {
  projectId: string;
  teamId: string;
  databaseName: string;
}

/** `msp_<projectId with dashes stripped>` — mirrors projectDatabaseName(). */
export function projectDatabaseNameFor(projectId: string): string {
  return 'msp_' + projectId.replace(/-/g, '');
}

/**
 * Every project whose per-project database actually exists.
 *
 * Driven from `projects` (the authoritative list) and intersected with
 * `pg_database`, because a project row can exist before its database is
 * provisioned — connecting to a missing database throws and would abort the
 * whole sweep partway through, leaving later projects unrecovered.
 *
 * The base project is EXCLUDED: its rows live in the base database, which the
 * caller already sweeps directly. Including it would double-process the dogfood.
 *
 * Never throws — recovery runs at startup and must not block boot.
 */
export async function listProjectTargets(
  basePool: RecoveryQueryable,
  opts: { baseProjectId?: string | null } = {},
): Promise<ProjectTarget[]> {
  try {
    const result = await basePool.query(
      `SELECT p.id, p.team_id
         FROM projects p
        WHERE EXISTS (
          SELECT 1 FROM pg_database d
           WHERE d.datname = 'msp_' || replace(p.id::text, '-', '')
        )`,
    );
    const base = opts.baseProjectId ?? null;
    return result.rows
      .map(r => ({
        projectId: String(r.id ?? ''),
        teamId: String(r.team_id ?? ''),
        databaseName: projectDatabaseNameFor(String(r.id ?? '')),
      }))
      .filter(t => t.projectId && t.teamId && t.projectId !== base);
  } catch {
    return [];
  }
}

export interface SweepDeps {
  /** Resolve (and cache) a pool for one project database. */
  getPool: (target: ProjectTarget) => Promise<RecoveryQueryable | null>;
  /** The recovery work to run against a single project's pool. */
  sweep: (pool: RecoveryQueryable, target: ProjectTarget) => Promise<number>;
  onProgress?: (info: { target: ProjectTarget; recovered: number }) => void;
}

/**
 * Apply one recovery sweep to every project database.
 *
 * Isolated per project: one unreachable database or one failing sweep must not
 * stop the others. That matters more here than usual, because the failure mode
 * being fixed IS silent partial coverage — a sweep that aborts halfway would
 * reproduce it in a new shape.
 *
 * Returns the total recovered across all projects. Never throws.
 */
export async function sweepAllProjects(
  targets: ProjectTarget[],
  deps: SweepDeps,
): Promise<{ total: number; projectsSwept: number; projectsFailed: number }> {
  let total = 0;
  let projectsSwept = 0;
  let projectsFailed = 0;
  for (const target of targets) {
    try {
      const pool = await deps.getPool(target);
      if (!pool) { projectsFailed += 1; continue; }
      const recovered = await deps.sweep(pool, target);
      total += recovered;
      projectsSwept += 1;
      if (recovered > 0) deps.onProgress?.({ target, recovered });
    } catch {
      projectsFailed += 1;
    }
  }
  return { total, projectsSwept, projectsFailed };
}
