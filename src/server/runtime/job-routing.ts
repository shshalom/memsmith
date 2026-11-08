// SPDX-License-Identifier: Apache-2.0
import { assertServerGenerationJobPayload } from '../jobs/types.js';
import { projectDatabaseName } from './resolve-project-database.js';
import type { DrainableJob } from './generation-drain.js';

export type JobRoute = 'runnable' | 'unrunnable' | 'unknown';

export interface JobRoutingContext<P> {
  basePool: P;
  baseProjectId: string | null;
  /** Null when per-project routing is not wired; every job then belongs to the base pool. */
  getPool: ((databaseName: string, scope: { teamId: string; projectId: string }) => Promise<P>) | null;
}

/**
 * Decide whether the worker would run `job`, found in `pool`, against that same
 * pool. `unrunnable` means the worker refuses it or resolves it to another
 * database; `unknown` means the pool lookup failed and the answer is not known yet.
 */
export async function classifyJobRoute<P>(
  pool: P,
  job: DrainableJob,
  ctx: JobRoutingContext<P>,
): Promise<JobRoute> {
  let payload;
  try { payload = assertServerGenerationJobPayload(job.payload); } catch { return 'unrunnable'; }
  if (payload.generation_job_id !== job.id) return 'unrunnable';
  if (!ctx.getPool || payload.project_id === ctx.baseProjectId) {
    return pool === ctx.basePool ? 'runnable' : 'unrunnable';
  }
  try {
    const target = await ctx.getPool(projectDatabaseName(payload.project_id), {
      teamId: payload.team_id, projectId: payload.project_id,
    });
    return target === pool ? 'runnable' : 'unrunnable';
  } catch {
    return 'unknown';
  }
}
