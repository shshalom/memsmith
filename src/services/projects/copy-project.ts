// SPDX-License-Identifier: Apache-2.0
//
// Copies one project's rows into another project's database, rewriting
// project_id and team_id.
//
// Two passes, both paged by id so no table is held in memory: the first reads
// only key columns and decides, for every source row, its target id and
// whether to copy it, update an earlier copy, or skip it; the second reads full
// rows, as text so timestamps keep microsecond precision, and writes them.
//
// Every inserted row is recorded in the target's memsmith_merge_provenance
// table (source id to target id), which is what undoMergeSql deletes by.
//
// Ids are kept unless the target holds a different row with that id; such
// rows get a derived id, the same on every run, so a second run finds them. A
// row the target already holds under a unique key (an event's idempotency
// key, a session's external id, an observation's generation key) is not
// copied again; its children point at the target's row.
import type { Queryable } from './projects-db.js';

export const COPY_TABLES = [
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
] as const;

export type CopyTable = (typeof COPY_TABLES)[number];

export interface TableCounts {
  /** Source rows this table's copy considers. */
  source: number;
  /** Rows the copy inserts. */
  copy: number;
  /** Rows the target already has, from an earlier run or under the same unique key. */
  alreadyThere: number;
  /** Earlier copies the source has changed since, which the copy updates. */
  updated: number;
  /** Copied rows that get a new id or idempotency key because the target uses theirs. */
  renamed: number;
}

export interface CopyReport {
  tables: Record<CopyTable, TableCounts>;
  /** Queued or processing source jobs, copied into the target as queued. Cancel them in the source after the copy commits. */
  activeJobIds: string[];
  /** Failed and cancelled jobs stay in the source. */
  finishedJobsLeftBehind: number;
  /** Source columns the target has no column for, per table. Their values are not copied. */
  droppedColumns: Partial<Record<CopyTable, string[]>>;
}

export interface CopyScope {
  fromProjectId: string;
  intoProjectId: string;
  intoTeamId: string;
  intoName: string;
}

type Row = Record<string, any>;
type Action = 'copy' | 'update' | 'skip';
interface Decision { target: string; action: Action }
type Decisions = Map<string, Decision>;

const PAGE = 500;
const INSERT_BATCH = 200;
const MAX_DERIVED = 5;
const UPDATABLE = new Set<CopyTable>(['server_sessions', 'observations']);
const TARGET_GAVE_UP = new Set(['failed', 'cancelled']);
const COPIED_JOB_STATUSES = ['completed', 'queued', 'processing'];
export const PROVENANCE_TABLE = 'memsmith_merge_provenance';
const us = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint::text`;

function emptyCounts(): Record<CopyTable, TableCounts> {
  return Object.fromEntries(COPY_TABLES.map((t) => [t, { source: 0, copy: 0, alreadyThere: 0, updated: 0, renamed: 0 }])) as Record<CopyTable, TableCounts>;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null) return false;
  if (b == null) return true;
  return BigInt(a) > BigInt(b);
}

/** Pages `select` (which must end in a WHERE clause on alias `x`) by x.id. */
async function* pages(db: Queryable, select: string, params: unknown[]): AsyncGenerator<Row[]> {
  let after = '';
  for (;;) {
    const result = await db.query(
      `${select} AND x.id > $${params.length + 1} ORDER BY x.id LIMIT ${PAGE}`,
      [...params, after],
    );
    if (result.rows.length === 0) return;
    yield result.rows;
    after = String(result.rows[result.rows.length - 1].id);
    if (result.rows.length < PAGE) return;
  }
}

const SOURCE_SCOPE: Record<CopyTable, string> = {
  server_sessions: 'FROM server_sessions x WHERE x.project_id = $1',
  agent_events: 'FROM agent_events x WHERE x.project_id = $1',
  observation_generation_jobs: `FROM observation_generation_jobs x WHERE x.project_id = $1 AND x.status IN ('completed', 'queued', 'processing')`,
  observations: 'FROM observations x WHERE x.project_id = $1',
  observation_sources: 'FROM observation_sources x JOIN observations o ON o.id = x.observation_id WHERE o.project_id = $1',
  observation_generation_job_events: `FROM observation_generation_job_events x JOIN observation_generation_jobs j ON j.id = x.generation_job_id
    WHERE j.project_id = $1 AND j.status IN ('completed', 'queued', 'processing')`,
};

const KEY_COLUMNS: Record<CopyTable, string> = {
  server_sessions: `x.id, ${us('x.created_at')} AS created_us, ${us('x.updated_at')} AS updated_us, x.idempotency_key, x.external_session_id, x.platform_source`,
  agent_events: `x.id, ${us('x.created_at')} AS created_us, x.idempotency_key`,
  observation_generation_jobs: `x.id, ${us('x.created_at')} AS created_us, x.status, x.idempotency_key, x.bullmq_job_id, x.source_type, x.source_id, x.job_type`,
  observations: `x.id, ${us('x.created_at')} AS created_us, ${us('x.updated_at')} AS updated_us, x.generation_key, x.idempotency_key, x.created_by_job_id`,
  observation_sources: `x.id, ${us('x.created_at')} AS created_us, x.observation_id, x.source_id`,
  observation_generation_job_events: `x.id, ${us('x.created_at')} AS created_us, x.generation_job_id`,
};

async function targetById(target: Queryable, table: CopyTable, ids: string[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  if (ids.length === 0) return found;
  const extra = table === 'observation_sources' ? ', observation_id, source_id'
    : table === 'observation_generation_job_events' ? ', generation_job_id'
    : `, project_id${UPDATABLE.has(table) ? `, ${us('updated_at')} AS updated_us` : ''}${table === 'observation_generation_jobs' ? ', status' : ''}`;
  const result = await target.query(`SELECT id, ${us('created_at')} AS created_us${extra} FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
  for (const r of result.rows) found.set(String(r.id), r);
  return found;
}

async function lookupColumn(target: Queryable, table: string, column: string, values: unknown[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  const distinct = [...new Set(values.filter((v) => v != null).map(String))];
  if (distinct.length === 0) return found;
  const result = await target.query(`SELECT id, project_id, ${column} FROM ${table} WHERE ${column} = ANY($1::text[])`, [distinct]);
  for (const r of result.rows) found.set(String(r[column]), r);
  return found;
}

interface ColumnSets { source: string[]; target: string[] }

async function columnsOf(db: Queryable, tables: readonly string[]): Promise<Map<string, string[]>> {
  const result = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND is_generated <> 'ALWAYS'
      ORDER BY table_name, ordinal_position`,
    [[...tables]],
  );
  const map = new Map<string, string[]>();
  for (const r of result.rows) map.set(r.table_name, [...(map.get(r.table_name) ?? []), String(r.column_name)]);
  return map;
}

/**
 * Plans the copy and, when `write` is true, performs it on `target`. Run it
 * inside a transaction on `target` so a failure leaves nothing behind.
 */
export async function copyProject(
  source: Queryable,
  target: Queryable,
  scope: CopyScope,
  write: boolean,
): Promise<CopyReport> {
  const counts = emptyCounts();
  const suffixBase = `-m${scope.fromProjectId.replace(/-/g, '').slice(0, 8)}`;
  const derived = (id: string, n: number) => `${id}${suffixBase}${n > 1 ? `-${n}` : ''}`;
  const decisions = Object.fromEntries(COPY_TABLES.map((t) => [t, new Map()])) as Record<CopyTable, Decisions>;
  const renamedKeys = { agent_events: new Set<string>(), observation_generation_jobs: new Set<string>() };
  const supersedes = new Map<string, string>();
  const activeJobIds: string[] = [];

  // A row skipped because the target produced its own version has no target id.
  const mapId = (table: CopyTable, id: unknown): string | null =>
    id == null ? null : decisions[table].get(String(id))?.target || null;

  // Target jobs that already ran: their status, and whether they wrote an
  // observation. A moved job can run in the target before the source's result
  // for the same job arrives, and both must not be kept.
  const targetJobStatus = new Map<string, string>();
  const sourceJobStatus = new Map<string, string>();
  const targetGenerated = new Set<string>();
  const sourceGenerated = new Set<string>();
  const completeFromSource = new Set<string>();
  const adoptedJobs = new Map<string, string>();
  const noteTargetJobs = async (ids: string[]) => {
    const unknown = [...new Set(ids)].filter((id) => id && !targetJobStatus.has(id));
    if (unknown.length === 0) return;
    // A target worker persists a job's result while holding this row lock, so
    // the merge waits for it and then reads the worker's result.
    for (const r of (await target.query(
      `SELECT id, status FROM observation_generation_jobs WHERE project_id = $1 AND id = ANY($2::text[])${write ? ' ORDER BY id FOR UPDATE' : ''}`,
      [scope.intoProjectId, unknown],
    )).rows) targetJobStatus.set(String(r.id), String(r.status));
    for (const r of (await target.query(
      'SELECT DISTINCT created_by_job_id AS id FROM observations WHERE project_id = $1 AND created_by_job_id = ANY($2::text[])', [scope.intoProjectId, unknown],
    )).rows) targetGenerated.add(String(r.id));
    for (const id of unknown) if (!targetJobStatus.has(id)) targetJobStatus.set(id, '');
  };

  // Decides one page of rows. `duplicateOf` returns the target row's id when
  // the target holds this row under a unique key.
  async function decide(
    table: CopyTable,
    rows: Row[],
    sameRow: (existing: Row, row: Row) => boolean,
    duplicateOf: (row: Row) => string | undefined = () => undefined,
    excluded: (row: Row) => boolean = () => false,
  ): Promise<void> {
    const map = decisions[table];
    let pending: Row[] = [];
    const existingById = await targetById(target, table, rows.map((r) => String(r.id)));
    const settle = (row: Row, id: string, existing: Row | undefined, renamed: boolean) => {
      if (!existing) {
        if (excluded(row)) {
          map.set(row.id, { target: '', action: 'skip' });
          counts[table].alreadyThere += 1;
          return true;
        }
        map.set(row.id, { target: id, action: 'copy' });
        counts[table].copy += 1;
        if (renamed) counts[table].renamed += 1;
        return true;
      }
      if (!sameRow(existing, row)) return false;
      // A moved job has one result. When the target's copy wrote none and
      // the source produced one, the source's result completes the target's
      // copy: a queued copy must not run again, and a failed or cancelled
      // copy never will.
      const finishedInSource = table === 'observation_generation_jobs'
        && !targetGenerated.has(String(existing.id))
        && (row.status === 'completed'
          ? existing.status !== 'completed'
          : TARGET_GAVE_UP.has(String(existing.status)) && sourceGenerated.has(String(row.id)));
      if (finishedInSource) completeFromSource.add(String(row.id));
      const update = finishedInSource || (UPDATABLE.has(table) && newer(row.updated_us, existing.updated_us));
      map.set(row.id, { target: id, action: update ? 'update' : 'skip' });
      if (update) counts[table].updated += 1;
      else counts[table].alreadyThere += 1;
      return true;
    };
    for (const row of rows) {
      counts[table].source += 1;
      const dup = duplicateOf(row);
      if (dup !== undefined) {
        map.set(row.id, { target: dup, action: 'skip' });
        counts[table].alreadyThere += 1;
        continue;
      }
      if (!settle(row, row.id, existingById.get(row.id), false)) pending.push(row);
    }
    for (let n = 1; n <= MAX_DERIVED && pending.length > 0; n++) {
      const found = await targetById(target, table, pending.map((r) => derived(r.id, n)));
      pending = pending.filter((row) => !settle(row, derived(row.id, n), found.get(derived(row.id, n)), true));
    }
    if (pending.length > 0) {
      throw new Error(`${table} ${pending[0].id}: the target uses that id and ${MAX_DERIVED} derived ids, so the row cannot be copied`);
    }
  }

  const inTarget = (row: Row) => row.project_id === scope.intoProjectId;
  const sameProjectRow = (existing: Row, row: Row) => inTarget(existing) && existing.created_us === row.created_us;
  const keyPages = (table: CopyTable) => pages(source, `SELECT ${KEY_COLUMNS[table]} ${SOURCE_SCOPE[table]}`, [scope.fromProjectId]);

  // Sessions: one coding session can span two folders that resolved to two
  // projects, so the target may already hold it under the same external id.
  const sessionByKey = new Map<string, string>();
  const sessionByIdem = new Map<string, string>();
  const sessionKey = (r: Row) => (r.external_session_id ? `${r.platform_source ?? ''}\u0000${r.external_session_id}` : null);
  for await (const page of pages(target, 'SELECT x.id, x.idempotency_key, x.external_session_id, x.platform_source FROM server_sessions x WHERE x.project_id = $1', [scope.intoProjectId])) {
    for (const s of page) {
      const key = sessionKey(s);
      if (key) sessionByKey.set(key, s.id);
      if (s.idempotency_key) sessionByIdem.set(s.idempotency_key, s.id);
    }
  }
  for await (const page of keyPages('server_sessions')) {
    await decide('server_sessions', page, sameProjectRow, (r) => {
      const key = sessionKey(r);
      const dup = (key ? sessionByKey.get(key) : undefined) ?? (r.idempotency_key ? sessionByIdem.get(r.idempotency_key) : undefined);
      return dup !== undefined && dup !== r.id ? dup : undefined;
    });
  }

  // Events: idempotency_key is unique across the whole database.
  for await (const page of keyPages('agent_events')) {
    const holders = await lookupColumn(target, 'agent_events', 'idempotency_key', page.map((r) => r.idempotency_key));
    await decide('agent_events', page, sameProjectRow, (r) => {
      const holder = holders.get(r.idempotency_key);
      if (!holder || holder.id === r.id) return undefined;
      if (inTarget(holder)) return String(holder.id);
      renamedKeys.agent_events.add(r.id);
      return undefined;
    });
  }

  const finished = await source.query(
    `SELECT count(*)::int AS n FROM observation_generation_jobs WHERE project_id = $1 AND status NOT IN ('completed', 'queued', 'processing')`,
    [scope.fromProjectId],
  );
  const jobSourceId = (j: Row): string => {
    if (j.source_type === 'agent_event') return mapId('agent_events', j.source_id) ?? j.source_id;
    if (j.source_type === 'session_summary') return mapId('server_sessions', j.source_id) ?? j.source_id;
    return mapId('observations', j.source_id) ?? j.source_id;
  };
  const jobScopes = new Map<string, string>();
  for await (const page of pages(target,
    'SELECT x.id, x.source_type, x.source_id, x.job_type FROM observation_generation_jobs x WHERE x.project_id = $1 AND x.team_id = $2',
    [scope.intoProjectId, scope.intoTeamId])) {
    for (const j of page) jobScopes.set(`${j.source_type}\u0000${j.source_id}\u0000${j.job_type}`, j.id);
  }
  const bullmqTaken = new Set<string>();
  for await (const page of keyPages('observation_generation_jobs')) {
    for (const j of page) {
      sourceJobStatus.set(String(j.id), String(j.status));
      if (j.status !== 'completed') activeJobIds.push(String(j.id));
    }
    for (const r of (await source.query(
      'SELECT DISTINCT created_by_job_id AS id FROM observations WHERE project_id = $1 AND created_by_job_id = ANY($2::text[])',
      [scope.fromProjectId, page.map((j) => String(j.id))],
    )).rows) sourceGenerated.add(String(r.id));
    const holders = await lookupColumn(target, 'observation_generation_jobs', 'idempotency_key', page.map((j) => j.idempotency_key));
    for (const id of (await lookupColumn(target, 'observation_generation_jobs', 'bullmq_job_id', page.map((j) => j.bullmq_job_id))).keys()) bullmqTaken.add(id);
    const scopedOf = (j: Row) => jobScopes.get(`${j.source_type}\u0000${jobSourceId(j)}\u0000${j.job_type}`);
    await noteTargetJobs(page.flatMap((j) => [
      String(j.id),
      ...Array.from({ length: MAX_DERIVED }, (_, i) => derived(String(j.id), i + 1)),
      ...[scopedOf(j), holders.get(j.idempotency_key)?.id].filter((id): id is string => id != null).map(String),
    ]));
    await decide('observation_generation_jobs', page, sameProjectRow, (j) => {
      const scoped = scopedOf(j);
      if (scoped !== undefined && scoped !== j.id) return scoped;
      const holder = holders.get(j.idempotency_key);
      if (!holder || holder.id === j.id) return undefined;
      if (inTarget(holder)) return String(holder.id);
      renamedKeys.observation_generation_jobs.add(j.id);
      return undefined;
    });
  }

  const keyedObs = new Map<string, string>();
  for await (const page of pages(target,
    `SELECT x.id, x.generation_key, x.idempotency_key FROM observations x
      WHERE x.project_id = $1 AND x.team_id = $2 AND (x.generation_key IS NOT NULL OR x.idempotency_key IS NOT NULL)`,
    [scope.intoProjectId, scope.intoTeamId])) {
    for (const o of page) {
      if (o.generation_key) keyedObs.set(`g\u0000${o.generation_key}`, o.id);
      if (o.idempotency_key) keyedObs.set(`i\u0000${o.idempotency_key}`, o.id);
    }
  }
  for await (const page of keyPages('observations')) {
    const candidates = (jobId: string) => [jobId, ...Array.from({ length: MAX_DERIVED }, (_, i) => derived(jobId, i + 1))];
    await noteTargetJobs(page.flatMap((o) => (o.created_by_job_id == null ? [] : candidates(String(o.created_by_job_id)))));
    await decide('observations', page, sameProjectRow, (r) => {
      const dup = (r.generation_key && keyedObs.get(`g\u0000${r.generation_key}`)) || (r.idempotency_key && keyedObs.get(`i\u0000${r.idempotency_key}`));
      return dup && dup !== r.id ? dup : undefined;
    }, (o) => {
      // One job, one result. A source observation comes along only when its
      // job's result is the source's: the job is copied as completed, or its
      // queued target copy is being completed from the source. Otherwise the
      // target's copy owns the job (it ran, or will run), including a source
      // job cancelled while its observation was still committing.
      if (o.created_by_job_id == null) return false;
      const jobId = String(o.created_by_job_id);
      const job = decisions.observation_generation_jobs.get(jobId);
      if (job) {
        if (job.action === 'update') return false;
        if (job.action === 'copy') return sourceJobStatus.get(jobId) !== 'completed';
        // The target holds its own job for this work. It keeps that job's
        // result, unless the job gave up without one.
        const status = job.target ? targetJobStatus.get(job.target) : undefined;
        if (status && TARGET_GAVE_UP.has(status) && !targetGenerated.has(job.target) && sourceGenerated.has(jobId)) {
          adoptedJobs.set(jobId, job.target);
          return false;
        }
        return true;
      }
      // The source job is no longer moved (it was cancelled after an earlier
      // pass copied it). Its target copy owns the job unless that copy gave
      // up without output; then the source's observation is the result.
      const held = candidates(jobId).filter((id) => Boolean(targetJobStatus.get(id)));
      if (held.length === 0) return false;
      if (held.some((id) => targetGenerated.has(id) || !TARGET_GAVE_UP.has(targetJobStatus.get(id)!))) return true;
      adoptedJobs.set(jobId, held[held.length - 1]);
      return false;
    });
  }

  counts.observation_generation_jobs.updated += new Set(adoptedJobs.values()).size;

  const written = (table: CopyTable, id: unknown) => {
    const d = id == null ? undefined : decisions[table].get(String(id));
    return d !== undefined && d.action !== 'skip';
  };
  for await (const page of keyPages('observation_sources')) {
    const rows = page.filter((s) => written('observations', s.observation_id));
    if (rows.length > 0) {
      await decide('observation_sources', rows, (existing, row) =>
        existing.observation_id === mapId('observations', row.observation_id) && existing.source_id === row.source_id);
    }
  }
  for await (const page of keyPages('observation_generation_job_events')) {
    const rows = page.filter((e) => decisions.observation_generation_jobs.get(String(e.generation_job_id))?.action === 'copy');
    if (rows.length > 0) {
      await decide('observation_generation_job_events', rows, (existing, row) =>
        existing.generation_job_id === mapId('observation_generation_jobs', row.generation_job_id) && existing.created_us === row.created_us);
    }
  }

  const sourceColumns = await columnsOf(source, COPY_TABLES);
  const targetColumns = await columnsOf(target, COPY_TABLES);
  const droppedColumns: CopyReport['droppedColumns'] = {};
  for (const table of COPY_TABLES) {
    const targetSet = new Set(targetColumns.get(table) ?? []);
    const dropped = (sourceColumns.get(table) ?? []).filter((c) => !targetSet.has(c));
    if (dropped.length > 0) droppedColumns[table] = dropped;
  }
  const report: CopyReport = { tables: counts, activeJobIds, finishedJobsLeftBehind: Number(finished.rows[0]?.n ?? 0), droppedColumns };
  if (!write) return report;

  await target.query(
    `CREATE TABLE IF NOT EXISTS ${PROVENANCE_TABLE} (
       source_project_id TEXT NOT NULL,
       table_name TEXT NOT NULL,
       source_id TEXT NOT NULL,
       target_id TEXT NOT NULL,
       merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (source_project_id, table_name, target_id)
     )`,
  );
  await target.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [scope.intoTeamId]);
  await target.query(
    'INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [scope.intoProjectId, scope.intoTeamId, scope.intoName],
  );

  const rewrite = (table: CopyTable, row: Row, targetId: string): Row => {
    const out: Row = { ...row, id: targetId };
    if ('project_id' in out) out.project_id = scope.intoProjectId;
    if ('team_id' in out) out.team_id = scope.intoTeamId;
    if (table === 'agent_events') {
      out.server_session_id = mapId('server_sessions', row.server_session_id);
      if (renamedKeys.agent_events.has(row.id)) out.idempotency_key = `${row.idempotency_key}${suffixBase}`;
    } else if (table === 'observation_generation_jobs') {
      out.agent_event_id = mapId('agent_events', row.agent_event_id);
      out.server_session_id = mapId('server_sessions', row.server_session_id);
      out.source_id = jobSourceId(row);
      if (renamedKeys.observation_generation_jobs.has(row.id)) out.idempotency_key = `${row.idempotency_key}${suffixBase}`;
      if (row.bullmq_job_id && bullmqTaken.has(String(row.bullmq_job_id))) out.bullmq_job_id = null;
      if (completeFromSource.has(String(row.id))) {
        out.status = 'completed';
        out.completed_at = row.completed_at ?? new Date().toISOString();
        out.failed_at = null;
        out.cancelled_at = null;
        out.last_error = null;
        out.locked_at = null;
        out.locked_by = null;
      } else if (row.status !== 'completed') {
        out.status = 'queued';
        out.locked_at = null;
        out.locked_by = null;
      }
      if (row.payload) {
        try {
          const payload = JSON.parse(row.payload);
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            if ('project_id' in payload) payload.project_id = scope.intoProjectId;
            if ('team_id' in payload) payload.team_id = scope.intoTeamId;
            if ('generation_job_id' in payload) payload.generation_job_id = targetId;
            if ('agent_event_id' in payload) payload.agent_event_id = mapId('agent_events', payload.agent_event_id);
            if ('source_id' in payload) payload.source_id = out.source_id;
            if ('server_session_id' in payload) payload.server_session_id = mapId('server_sessions', payload.server_session_id) ?? payload.server_session_id;
            // The source team's keys don't belong to the target, and prune deletes them.
            if ('api_key_id' in payload) payload.api_key_id = null;
            out.payload = JSON.stringify(payload);
          }
        } catch {
          // Keep a payload that is not a JSON object as it is.
        }
      }
    } else if (table === 'observations') {
      out.server_session_id = mapId('server_sessions', row.server_session_id);
      out.created_by_job_id = mapId('observation_generation_jobs', row.created_by_job_id)
        ?? (row.created_by_job_id == null ? null : adoptedJobs.get(String(row.created_by_job_id)) ?? null);
      if (row.supersedes != null) supersedes.set(targetId, String(row.supersedes));
      out.supersedes = null;
    } else if (table === 'observation_sources') {
      out.observation_id = mapId('observations', row.observation_id);
      out.agent_event_id = mapId('agent_events', row.agent_event_id);
      out.generation_job_id = mapId('observation_generation_jobs', row.generation_job_id);
      out.source_id = row.source_type === 'agent_event' ? mapId('agent_events', row.source_id)
        : row.source_type === 'session_summary' ? (mapId('server_sessions', row.source_id) ?? row.source_id)
        : row.source_type === 'observation_reindex' ? (mapId('observations', row.source_id) ?? row.source_id)
        : row.source_id;
    } else if (table === 'observation_generation_job_events') {
      out.generation_job_id = mapId('observation_generation_jobs', row.generation_job_id);
    } else if (table === 'server_sessions') {
      // Only project_id and team_id change.
    }
    return out;
  };

  for (const table of COPY_TABLES) {
    const decided = decisions[table];
    if (![...decided.values()].some((d) => d.action !== 'skip')) continue;
    const targetSet = new Set(targetColumns.get(table) ?? []);
    const cols = (sourceColumns.get(table) ?? []).filter((c) => targetSet.has(c));
    const select = `SELECT ${cols.map((c) => `x."${c}"::text AS "${c}"`).join(', ')} ${SOURCE_SCOPE[table]}`;
    const onConflict = table === 'observation_sources' ? ' ON CONFLICT DO NOTHING' : '';
    let inserted = 0;
    for await (const page of pages(source, select, [scope.fromProjectId])) {
      const inserts: Row[] = [];
      const sourceIdOf = new Map<string, string>();
      for (const row of page) {
        const d = decided.get(String(row.id));
        if (!d || d.action === 'skip') continue;
        const out = rewrite(table, row, d.target);
        if (table === 'observation_sources' && out.source_type === 'agent_event' && !out.agent_event_id) continue;
        if (d.action === 'copy') {
          inserts.push(out);
          sourceIdOf.set(String(out.id), String(row.id));
        } else {
          const setCols = cols.filter((c) => c !== 'id');
          await target.query(
            `UPDATE ${table} SET ${setCols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id = $${setCols.length + 1}`,
            [...setCols.map((c) => out[c] ?? null), d.target],
          );
        }
      }
      for (const batch of chunks(inserts, INSERT_BATCH)) {
        const values: unknown[] = [];
        const tuples = batch.map((r) => `(${cols.map((c) => { values.push(r[c] ?? null); return `$${values.length}`; }).join(', ')})`);
        const result = await target.query(
          `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${tuples.join(', ')}${onConflict} RETURNING id`,
          values,
        );
        inserted += result.rows.length;
        const targetIds = result.rows.map((r) => String(r.id));
        await target.query(
          `INSERT INTO ${PROVENANCE_TABLE} (source_project_id, table_name, source_id, target_id)
           SELECT $1, $2, v.source_id, v.target_id FROM unnest($3::text[], $4::text[]) AS v(source_id, target_id)
           ON CONFLICT DO NOTHING`,
          [scope.fromProjectId, table, targetIds.map((id) => sourceIdOf.get(id) ?? id), targetIds],
        );
      }
    }
    counts[table].copy = inserted;
  }

  const adopted = [...new Set(adoptedJobs.values())];
  if (adopted.length > 0) {
    await target.query(
      `UPDATE observation_generation_jobs
          SET status = 'completed', completed_at = now(), failed_at = NULL, cancelled_at = NULL,
              last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE project_id = $1 AND id = ANY($2::text[])`,
      [scope.intoProjectId, adopted],
    );
  }

  const links = [...supersedes.entries()]
    .map(([id, original]) => ({ id, supersedes: mapId('observations', original) }))
    .filter((l): l is { id: string; supersedes: string } => l.supersedes !== null);
  for (const batch of chunks(links, PAGE)) {
    await target.query(
      `UPDATE observations o SET supersedes = v.supersedes
         FROM unnest($1::text[], $2::text[]) AS v(id, supersedes)
        WHERE o.id = v.id`,
      [batch.map((l) => l.id), batch.map((l) => l.supersedes)],
    );
  }

  return report;
}

/**
 * SQL that deletes, from the target database, every row a merge from
 * `fromProjectId` inserted, children first, then forgets those records. Rows
 * the target already had are not in the provenance table, so they stay.
 */
export function undoMergeSql(fromProjectId: string): string {
  const id = fromProjectId.replace(/'/g, "''");
  const tables = [...COPY_TABLES].reverse();
  return [
    ...tables.map((t) => `DELETE FROM ${t} WHERE id IN (SELECT target_id FROM ${PROVENANCE_TABLE} WHERE source_project_id = '${id}' AND table_name = '${t}');`),
    `DELETE FROM ${PROVENANCE_TABLE} WHERE source_project_id = '${id}';`,
  ].join('\n');
}

/**
 * Cancels the given source jobs if they are still queued or processing. The
 * generator drops a cancelled job before it writes. Call it only after their
 * copies in the target are committed.
 */
export async function cancelSourceJobs(source: Queryable, ids: string[], intoProjectId: string): Promise<number> {
  let cancelled = 0;
  for (const batch of chunks(ids, PAGE)) {
    const result = await source.query(
      `WITH cancelled AS (
         UPDATE observation_generation_jobs
            SET status = 'cancelled', cancelled_at = now(), updated_at = now(), locked_at = NULL, locked_by = NULL
          WHERE id = ANY($1::text[]) AND status IN ('queued', 'processing')
          RETURNING id, attempts
       ), logged AS (
         INSERT INTO observation_generation_job_events (id, generation_job_id, event_type, status_after, attempt, details)
         SELECT gen_random_uuid()::text, id, 'cancelled', 'cancelled', attempts,
                jsonb_build_object('reason', 'moved to the merged project', 'mergedInto', $2::text)
           FROM cancelled
         RETURNING 1
       )
       SELECT count(*)::int AS cancelled FROM cancelled`,
      [batch, intoProjectId],
    );
    cancelled += Number(result.rows[0]?.cancelled ?? 0);
  }
  return cancelled;
}
