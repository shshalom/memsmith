// SPDX-License-Identifier: Apache-2.0
//
// Copies one project's rows into another project's database, rewriting
// project_id and team_id. Ids are kept unless the target already holds a
// different row with that id; such rows get a derived id, so a second run maps
// them to the same id and skips them. A row the target already has under a
// unique key (an event's idempotency key, a session's external id, an
// observation's generation key) is not copied again; its children point at the
// target's row.
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
  /** Rows in the source project that this table's copy considers. */
  source: number;
  /** Rows the copy inserts. */
  copy: number;
  /** Rows the target already has, from an earlier run or under the same unique key. */
  alreadyThere: number;
  /** Copied rows that get a new id or idempotency key because the target uses theirs. */
  renamed: number;
}

export interface CopyReport {
  tables: Record<CopyTable, TableCounts>;
  /** Jobs that are not copied: queued or processing ones are cancelled instead, and failed or cancelled ones stay behind. */
  jobsLeftBehind: { active: number; finished: number };
}

export interface CopyScope {
  fromProjectId: string;
  intoProjectId: string;
  intoTeamId: string;
  intoName: string;
}

type Row = Record<string, any>;
type IdMap = Map<string, string>;

const BATCH = 500;
const INSERT_BATCH = 200;

function emptyCounts(): Record<CopyTable, TableCounts> {
  return Object.fromEntries(COPY_TABLES.map((t) => [t, { source: 0, copy: 0, alreadyThere: 0, renamed: 0 }])) as Record<CopyTable, TableCounts>;
}

function sameInstant(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == b;
  return new Date(a as string).getTime() === new Date(b as string).getTime();
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function lookup(db: Queryable, table: string, column: string, values: unknown[], where = ''): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  const distinct = [...new Set(values.filter((v) => v != null).map(String))];
  for (const batch of chunks(distinct, BATCH)) {
    const result = await db.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::text[]) ${where}`, [batch]);
    for (const row of result.rows) found.set(String(row[column]), row);
  }
  return found;
}

export async function readSourceRows(source: Queryable, projectId: string): Promise<Record<CopyTable, Row[]>> {
  const q = async (sql: string) => (await source.query(sql, [projectId])).rows as Row[];
  return {
    server_sessions: await q('SELECT * FROM server_sessions WHERE project_id = $1 ORDER BY created_at, id'),
    agent_events: await q('SELECT * FROM agent_events WHERE project_id = $1 ORDER BY created_at, id'),
    observation_generation_jobs: await q('SELECT * FROM observation_generation_jobs WHERE project_id = $1 ORDER BY created_at, id'),
    observations: await q('SELECT * FROM observations WHERE project_id = $1 ORDER BY created_at, id'),
    observation_sources: await q(
      `SELECT s.* FROM observation_sources s JOIN observations o ON o.id = s.observation_id
        WHERE o.project_id = $1 ORDER BY s.created_at, s.id`,
    ),
    observation_generation_job_events: await q(
      `SELECT e.* FROM observation_generation_job_events e
         JOIN observation_generation_jobs j ON j.id = e.generation_job_id
        WHERE j.project_id = $1 AND j.status = 'completed' ORDER BY e.created_at, e.id`,
    ),
  };
}

interface ColumnInfo { name: string; json: boolean }

async function targetColumns(target: Queryable): Promise<Map<string, ColumnInfo[]>> {
  const result = await target.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND is_generated <> 'ALWAYS'
      ORDER BY table_name, ordinal_position`,
    [[...COPY_TABLES]],
  );
  const map = new Map<string, ColumnInfo[]>();
  for (const row of result.rows) {
    const list = map.get(row.table_name) ?? [];
    list.push({ name: String(row.column_name), json: row.data_type === 'jsonb' || row.data_type === 'json' });
    map.set(row.table_name, list);
  }
  return map;
}

async function insertRows(
  target: Queryable,
  table: CopyTable,
  rows: Row[],
  columns: ColumnInfo[],
  onConflict = '',
): Promise<number> {
  let inserted = 0;
  const present = columns.filter((c) => rows.some((r) => c.name in r));
  for (const batch of chunks(rows, INSERT_BATCH)) {
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const slots = present.map((c) => {
        const v = row[c.name];
        values.push(c.json && v != null ? JSON.stringify(v) : v ?? null);
        return `$${values.length}`;
      });
      return `(${slots.join(', ')})`;
    });
    const result = await target.query(
      `INSERT INTO ${table} (${present.map((c) => `"${c.name}"`).join(', ')}) VALUES ${tuples.join(', ')} ${onConflict}`,
      values,
    );
    inserted += result.rowCount ?? batch.length;
  }
  return inserted;
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
  const src = await readSourceRows(source, scope.fromProjectId);
  const counts = emptyCounts();
  const suffix = `-m${scope.fromProjectId.replace(/-/g, '').slice(0, 8)}`;
  const derive = (value: string) => `${value}${suffix}`;
  const inTarget = (row: Row | undefined) => row !== undefined && row.project_id === scope.intoProjectId;

  // Assigns each source row its target id. `duplicateOf` returns the target
  // row's id when the target already holds this row under a unique key.
  async function assign(
    table: CopyTable,
    rows: Row[],
    sameRow: (existing: Row, row: Row) => boolean,
    duplicateOf: (row: Row) => string | undefined = () => undefined,
  ): Promise<{ map: IdMap; copy: Row[] }> {
    const map: IdMap = new Map();
    const copy: Row[] = [];
    const byId = await lookup(target, table, 'id', rows.map((r) => r.id));
    const pending: Row[] = [];
    for (const row of rows) {
      counts[table].source += 1;
      const dup = duplicateOf(row);
      if (dup !== undefined) {
        map.set(row.id, dup);
        counts[table].alreadyThere += 1;
        continue;
      }
      const existing = byId.get(row.id);
      if (!existing) {
        map.set(row.id, row.id);
        copy.push(row);
      } else if (sameRow(existing, row)) {
        map.set(row.id, row.id);
        counts[table].alreadyThere += 1;
      } else {
        pending.push(row);
      }
    }
    const derived = await lookup(target, table, 'id', pending.map((r) => derive(r.id)));
    for (const row of pending) {
      const id = derive(row.id);
      const existing = derived.get(id);
      map.set(row.id, id);
      if (existing && sameRow(existing, row)) {
        counts[table].alreadyThere += 1;
      } else {
        copy.push({ ...row, id });
        counts[table].renamed += 1;
      }
    }
    return { map, copy };
  }

  const sameProjectRow = (existing: Row, row: Row) => inTarget(existing) && sameInstant(existing.created_at, row.created_at);
  const mapped = (map: IdMap, value: unknown) => (value == null ? null : map.get(String(value)) ?? null);

  // Sessions: one coding session can span two folders that resolved to two
  // projects, so the target may already hold it under the same external id.
  const targetSessions = (await target.query('SELECT * FROM server_sessions WHERE project_id = $1', [scope.intoProjectId])).rows as Row[];
  const sessionKey = (r: Row) => (r.external_session_id ? `${r.platform_source ?? ''}\u0000${r.external_session_id}` : null);
  const sessionByKey = new Map<string, string>();
  const sessionByIdem = new Map<string, string>();
  for (const s of targetSessions) {
    const key = sessionKey(s);
    if (key) sessionByKey.set(key, s.id);
    if (s.idempotency_key) sessionByIdem.set(s.idempotency_key, s.id);
  }
  const sessions = await assign('server_sessions', src.server_sessions, sameProjectRow, (r) => {
    const key = sessionKey(r);
    const viaKey = key ? sessionByKey.get(key) : undefined;
    const viaIdem = r.idempotency_key ? sessionByIdem.get(r.idempotency_key) : undefined;
    const dup = viaKey ?? viaIdem;
    return dup !== undefined && dup !== r.id ? dup : undefined;
  });

  // Events: idempotency_key is unique across the whole database.
  const eventKeys = await lookup(target, 'agent_events', 'idempotency_key', src.agent_events.map((r) => r.idempotency_key));
  const renamedEventKeys = new Set<string>();
  const events = await assign('agent_events', src.agent_events, sameProjectRow, (r) => {
    const holder = eventKeys.get(r.idempotency_key);
    if (!holder || holder.id === r.id) return undefined;
    if (inTarget(holder)) return String(holder.id);
    renamedEventKeys.add(r.id);
    return undefined;
  });

  const obsByGenKey = new Map<string, string>();
  const obsByIdem = new Map<string, string>();
  const targetKeyed = (await target.query(
    `SELECT id, generation_key, idempotency_key FROM observations
      WHERE project_id = $1 AND team_id = $2 AND (generation_key IS NOT NULL OR idempotency_key IS NOT NULL)`,
    [scope.intoProjectId, scope.intoTeamId],
  )).rows as Row[];
  for (const o of targetKeyed) {
    if (o.generation_key) obsByGenKey.set(o.generation_key, o.id);
    if (o.idempotency_key) obsByIdem.set(o.idempotency_key, o.id);
  }
  const observations = await assign('observations', src.observations, sameProjectRow, (r) => {
    const dup = (r.generation_key && obsByGenKey.get(r.generation_key)) || (r.idempotency_key && obsByIdem.get(r.idempotency_key));
    return dup && dup !== r.id ? dup : undefined;
  });

  const completed = src.observation_generation_jobs.filter((j) => j.status === 'completed');
  const jobsLeftBehind = {
    active: src.observation_generation_jobs.filter((j) => j.status === 'queued' || j.status === 'processing').length,
    finished: src.observation_generation_jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
  };
  const jobSourceId = (j: Row): string => {
    if (j.source_type === 'agent_event') return events.map.get(j.source_id) ?? j.source_id;
    if (j.source_type === 'session_summary') return sessions.map.get(j.source_id) ?? j.source_id;
    return observations.map.get(j.source_id) ?? j.source_id;
  };
  const jobKeys = await lookup(target, 'observation_generation_jobs', 'idempotency_key', completed.map((j) => j.idempotency_key));
  const targetJobScopes = new Map<string, string>();
  for (const j of (await target.query(
    'SELECT id, source_type, source_id, job_type FROM observation_generation_jobs WHERE project_id = $1 AND team_id = $2',
    [scope.intoProjectId, scope.intoTeamId],
  )).rows as Row[]) {
    targetJobScopes.set(`${j.source_type}\u0000${j.source_id}\u0000${j.job_type}`, j.id);
  }
  const renamedJobKeys = new Set<string>();
  const jobs = await assign('observation_generation_jobs', completed, sameProjectRow, (j) => {
    const scoped = targetJobScopes.get(`${j.source_type}\u0000${jobSourceId(j)}\u0000${j.job_type}`);
    if (scoped !== undefined && scoped !== j.id) return scoped;
    const holder = jobKeys.get(j.idempotency_key);
    if (!holder || holder.id === j.id) return undefined;
    if (inTarget(holder)) return String(holder.id);
    renamedJobKeys.add(j.id);
    return undefined;
  });
  const bullmqTaken = await lookup(target, 'observation_generation_jobs', 'bullmq_job_id', jobs.copy.map((j) => j.bullmq_job_id));

  const copiedObservations = new Set(observations.copy.map((o) => String(o.id)));
  const sourceRows = src.observation_sources.filter((s) => copiedObservations.has(observations.map.get(s.observation_id)!));
  const sources = await assign('observation_sources', sourceRows, (existing, row) =>
    existing.observation_id === observations.map.get(row.observation_id) && existing.source_id === row.source_id);
  const copiedJobs = new Set(jobs.copy.map((j) => String(j.id)));
  const jobEventRows = src.observation_generation_job_events.filter((e) => copiedJobs.has(jobs.map.get(e.generation_job_id)!));
  const jobEvents = await assign('observation_generation_job_events', jobEventRows, (existing, row) =>
    existing.generation_job_id === jobs.map.get(row.generation_job_id) && sameInstant(existing.created_at, row.created_at));

  const scoped = (row: Row) => ({ ...row, project_id: scope.intoProjectId, team_id: scope.intoTeamId });
  const rewritten: Record<CopyTable, Row[]> = {
    server_sessions: sessions.copy.map(scoped),
    agent_events: events.copy.map((e) => ({
      ...scoped(e),
      server_session_id: mapped(sessions.map, e.server_session_id),
      idempotency_key: renamedEventKeys.has(e.id) ? `${e.idempotency_key}${suffix}` : e.idempotency_key,
    })),
    observation_generation_jobs: jobs.copy.map((j) => {
      const sourceId = jobSourceId(j);
      const payload = j.payload && typeof j.payload === 'object' && !Array.isArray(j.payload)
        ? {
            ...j.payload,
            ...('project_id' in j.payload ? { project_id: scope.intoProjectId } : {}),
            ...('team_id' in j.payload ? { team_id: scope.intoTeamId } : {}),
            ...('generation_job_id' in j.payload ? { generation_job_id: j.id } : {}),
            ...('agent_event_id' in j.payload ? { agent_event_id: mapped(events.map, j.payload.agent_event_id) } : {}),
          }
        : j.payload;
      return {
        ...scoped(j),
        agent_event_id: mapped(events.map, j.agent_event_id),
        server_session_id: mapped(sessions.map, j.server_session_id),
        source_id: sourceId,
        idempotency_key: renamedJobKeys.has(j.id) ? `${j.idempotency_key}${suffix}` : j.idempotency_key,
        bullmq_job_id: j.bullmq_job_id && bullmqTaken.has(String(j.bullmq_job_id)) ? null : j.bullmq_job_id,
        payload,
      };
    }),
    observations: observations.copy.map((o) => ({
      ...scoped(o),
      server_session_id: mapped(sessions.map, o.server_session_id),
      created_by_job_id: mapped(jobs.map, o.created_by_job_id),
      supersedes: null,
    })),
    observation_sources: sources.copy.map((s): Row => ({
      ...s,
      observation_id: observations.map.get(s.observation_id),
      agent_event_id: mapped(events.map, s.agent_event_id),
      generation_job_id: mapped(jobs.map, s.generation_job_id),
      source_id: s.source_type === 'agent_event' ? mapped(events.map, s.source_id)
        : s.source_type === 'session_summary' ? (sessions.map.get(s.source_id) ?? s.source_id)
        : s.source_type === 'observation_reindex' ? (observations.map.get(s.source_id) ?? s.source_id)
        : s.source_id,
    })).filter((s) => s.source_type !== 'agent_event' || s.agent_event_id),
    observation_generation_job_events: jobEvents.copy.map((e) => ({ ...e, generation_job_id: jobs.map.get(e.generation_job_id) })),
  };
  for (const table of COPY_TABLES) counts[table].copy = rewritten[table].length;

  if (!write) return { tables: counts, jobsLeftBehind };

  await target.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [scope.intoTeamId]);
  await target.query(
    'INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [scope.intoProjectId, scope.intoTeamId, scope.intoName],
  );
  const columns = await targetColumns(target);
  for (const table of COPY_TABLES) {
    const rows = rewritten[table];
    if (rows.length === 0) continue;
    const conflict = table === 'observation_sources' ? 'ON CONFLICT DO NOTHING' : '';
    counts[table].copy = await insertRows(target, table, rows, columns.get(table) ?? [], conflict);
  }

  const links = src.observations
    .filter((o) => o.supersedes != null && copiedObservations.has(observations.map.get(o.id)!))
    .map((o) => ({ id: observations.map.get(o.id)!, supersedes: mapped(observations.map, o.supersedes) }))
    .filter((l) => l.supersedes);
  for (const batch of chunks(links, BATCH)) {
    await target.query(
      `UPDATE observations o SET supersedes = v.supersedes
         FROM unnest($1::text[], $2::text[]) AS v(id, supersedes)
        WHERE o.id = v.id`,
      [batch.map((l) => l.id), batch.map((l) => l.supersedes)],
    );
  }

  return { tables: counts, jobsLeftBehind };
}

/** Cancels the source project's queued and processing jobs; the generator drops a cancelled job before it writes. */
export async function cancelActiveJobs(source: Queryable, fromProjectId: string, intoProjectId: string): Promise<number> {
  const result = await source.query(
    `WITH cancelled AS (
       UPDATE observation_generation_jobs
          SET status = 'cancelled', cancelled_at = now(), updated_at = now(), locked_at = NULL, locked_by = NULL
        WHERE project_id = $1 AND status IN ('queued', 'processing')
        RETURNING id, attempts
     ), logged AS (
       INSERT INTO observation_generation_job_events (id, generation_job_id, event_type, status_after, attempt, details)
       SELECT gen_random_uuid()::text, id, 'cancelled', 'cancelled', attempts,
              jsonb_build_object('reason', 'project merged', 'mergedInto', $2::text)
         FROM cancelled
       RETURNING 1
     )
     SELECT count(*)::int AS cancelled FROM cancelled`,
    [fromProjectId, intoProjectId],
  );
  return Number(result.rows[0]?.cancelled ?? 0);
}
