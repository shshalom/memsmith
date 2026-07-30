// SPDX-License-Identifier: Apache-2.0
//
// Startup recovery for the inline generation queue.
//
// The inline queue keeps its work list entirely in memory
// (InlineServerQueue.waiting[]), populated only by add() at enqueue time. Nothing
// ever reloaded status='queued' rows from Postgres, so every server restart
// abandoned whatever was mid-queue. Those rows stayed in the database forever,
// each still pointing at its source agent_event, but no process picked them up
// again. On the dogfood that reached 6,958 queued jobs spanning two weeks — all
// captured, none distilled, with no warning anywhere.
//
// Nothing was lost: the agent_events survive and every job retains
// agent_event_id / source_type / source_id / payload. The work is un-run, not
// deleted, which is exactly why replaying it recovers the lot.

export const DEFAULT_DRAIN_BATCH = 500;
export const DEFAULT_QUEUE_CONCURRENCY = 1;
export const MAX_QUEUE_CONCURRENCY = 16;

export interface DrainQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface DrainableJob {
  id: string;
  jobType: string;
  projectId: string;
  teamId: string;
  agentEventId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  serverSessionId: string | null;
  /**
   * The queue payload, persisted on the row at enqueue time.
   *
   * IngestEventsService builds this before inserting precisely so a re-enqueue
   * can reproduce a payload that passes the worker's validation — the row was
   * always designed to be replayable. Nothing ever replayed it.
   */
  payload: unknown;
  /** The queue's own job id, also persisted at enqueue time. */
  bullmqJobId: string | null;
}

function toJob(row: Record<string, unknown>): DrainableJob | null {
  const id = row.id;
  if (typeof id !== 'string' || !id) return null;
  const projectId = row.project_id;
  const teamId = row.team_id;
  if (typeof projectId !== 'string' || typeof teamId !== 'string') return null;
  return {
    id,
    jobType: typeof row.job_type === 'string' ? row.job_type : 'observation',
    projectId,
    teamId,
    agentEventId: typeof row.agent_event_id === 'string' ? row.agent_event_id : null,
    sourceType: typeof row.source_type === 'string' ? row.source_type : null,
    sourceId: typeof row.source_id === 'string' ? row.source_id : null,
    serverSessionId: typeof row.server_session_id === 'string' ? row.server_session_id : null,
    payload: row.payload ?? null,
    bullmqJobId: typeof row.bullmq_job_id === 'string' ? row.bullmq_job_id : null,
  };
}

/**
 * Load queued generation jobs so a restart no longer abandons them.
 *
 * Oldest first: the backlog can span weeks, and newest-first would starve the
 * oldest gaps — the ones a user is most likely to have already noticed missing.
 *
 * Bounded by LIMIT: 6,958 rows is survivable in one pass, an unbounded SELECT on a
 * larger install is not.
 *
 * Never throws — this runs at boot, and a drain failure must not stop the server
 * from starting.
 */
export async function loadQueuedJobsForDrain(
  pool: DrainQueryable,
  opts: { batchSize?: number } = {},
): Promise<DrainableJob[]> {
  const batchSize = opts.batchSize ?? DEFAULT_DRAIN_BATCH;
  try {
    const result = await pool.query(
      `SELECT id, job_type, project_id, team_id, agent_event_id,
              source_type, source_id, server_session_id, payload, bullmq_job_id
         FROM observation_generation_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT $1`,
      [batchSize],
    );
    // One malformed row must not cost the rest of the backlog.
    return result.rows.map(toJob).filter((j): j is DrainableJob => j !== null);
  } catch {
    return [];
  }
}

/**
 * How many generation jobs may run at once.
 *
 * Defaults to 1 (unchanged behaviour): a local model is memory-hungry — qwen2.5:14b
 * is ~9GB resident — so each concurrent job pins another copy. Raising it is an
 * explicit opt-in, and clamped, because unbounded concurrency OOMs the machine
 * rather than going faster.
 */
/**
 * How long a `processing` lock may sit before it is presumed dead.
 *
 * Generous on purpose: a real observation can take 20-60s on a local 14B model,
 * and reclaiming a job that is genuinely in flight would run it twice.
 */
export const DEFAULT_STALE_LOCK_MINUTES = 30;

/**
 * Return jobs stranded in `processing` back to `queued`.
 *
 * A job locked by a process that then died stays `processing` forever: the drain
 * cannot see it (that only looks at `queued`), and no worker will ever finish it.
 * Eleven such rows were found on the dogfood, locked since 2026-07-28 and never
 * touched again — the same orphaning as the queued backlog, one status along and
 * even quieter.
 *
 * Never throws — this runs at startup.
 */
export async function reclaimStaleLocks(
  pool: DrainQueryable,
  opts: { staleMinutes?: number } = {},
): Promise<number> {
  const staleMinutes = opts.staleMinutes ?? DEFAULT_STALE_LOCK_MINUTES;
  try {
    const result = await pool.query(
      `UPDATE observation_generation_jobs
          SET status = 'queued', locked_at = NULL, locked_by = NULL
        WHERE status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [staleMinutes],
    );
    return result.rows.length;
  } catch {
    return 0;
  }
}

/**
 * Return jobs that failed for a TRANSIENT reason back to `queued`.
 *
 * A job whose provider was briefly unreachable exhausts its 3 attempts and lands
 * in `failed` — correctly, at the time. But the cause was temporary, the work is
 * still wanted, and nothing ever retries it: the drain only looks at `queued` and
 * the reclaim only at `processing`. So a transient blip strands work in a third,
 * quietest way. Restarting ollama mid-drain produced exactly this:
 *   {"reason": "ollama network error: fetch failed", "classification": "transient"}
 *
 * Only `transient` rows are touched. A genuinely failed job (bad input, a
 * permanent provider rejection) must stay failed — retrying it forever would
 * burn the queue on work that can never succeed.
 *
 * Attempts are reset so the retried job gets a fresh budget rather than
 * immediately re-failing on an exhausted counter.
 *
 * Never throws.
 */
export async function reclaimTransientFailures(
  pool: DrainQueryable,
  opts: { limit?: number } = {},
): Promise<number> {
  const limit = opts.limit ?? DEFAULT_DRAIN_BATCH;
  try {
    const result = await pool.query(
      `UPDATE observation_generation_jobs
          SET status = 'queued', attempts = 0, locked_at = NULL, locked_by = NULL,
              failed_at = NULL
        WHERE id IN (
          SELECT id FROM observation_generation_jobs
           WHERE status = 'failed'
             AND last_error->>'classification' = 'transient'
           ORDER BY created_at ASC
           LIMIT $1
        )
        RETURNING id`,
      [limit],
    );
    return result.rows.length;
  } catch {
    return 0;
  }
}

/** Minimal shape of the queue a drained job is published back into. */
export interface RequeueTarget {
  add: (jobId: string, payload: unknown) => Promise<void>;
}

export interface RequeueDeps {
  /** Resolves the queue for a job kind, or null when queues are disabled. */
  resolveQueue: (kind: 'event' | 'summary') => RequeueTarget | null;
  onProgress?: (info: { requeued: number; skipped: number; total: number }) => void;
}

/**
 * Publish drained jobs back onto the queue.
 *
 * Mirrors IngestEventsService.publishEventJob exactly — `queue.add(jobId,
 * payload)` using the SAME persisted bullmqJobId and payload the row already
 * carries. That payload was built at enqueue time specifically so a re-enqueue
 * would pass the worker's validation, so this is replay, not reconstruction.
 *
 * Rows are left in `queued`: the processor owns the status transition, exactly as
 * on the normal path. A job that fails to publish simply stays queued for the
 * next boot.
 *
 * Never throws — this runs at startup.
 */
export async function requeueDrainedJobs(
  jobs: DrainableJob[],
  deps: RequeueDeps,
): Promise<{ requeued: number; skipped: number }> {
  let requeued = 0;
  let skipped = 0;
  for (const job of jobs) {
    try {
      // 'summary' jobs go to the summary lane; everything else is an event job.
      const kind = job.jobType === 'summary' ? 'summary' : 'event';
      const queue = deps.resolveQueue(kind);
      // No queue (disabled adapter) or no payload to replay → leave it queued.
      if (!queue || job.payload == null) { skipped += 1; continue; }
      await queue.add(job.bullmqJobId ?? job.id, job.payload);
      requeued += 1;
    } catch {
      // One bad job must not cost the rest of the backlog.
      skipped += 1;
    }
  }
  deps.onProgress?.({ requeued, skipped, total: jobs.length });
  return { requeued, skipped };
}

export function resolveQueueConcurrency(env: Record<string, string | undefined>): number {
  const raw = (env.MEMSMITH_GENERATION_CONCURRENCY ?? '').trim();
  if (!raw) return DEFAULT_QUEUE_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_QUEUE_CONCURRENCY;
  if (parsed < 1) return 1;
  if (parsed > MAX_QUEUE_CONCURRENCY) return MAX_QUEUE_CONCURRENCY;
  return parsed;
}
