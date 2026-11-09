// SPDX-License-Identifier: Apache-2.0
//
// Direct connection to the local runtime's embedded Postgres, the same way the
// hooks mint identities (local-base-dsn.ts) and `memsmith server jobs` reads
// the queue. Listing and merging span every project database, including
// databases no projects row names, which no per-project HTTP route can reach.
import pg from 'pg';
import { readRecordedAccountDatabase, readRecordedBaseProjectId, resolveLocalBaseDatabaseUrl } from '../identity/local-base-dsn.js';
import type { InventorySource, ProjectRow, RecordStats } from './inventory.js';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface ClientLike extends Queryable {
  release(): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

export function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function databaseFromUrl(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, '')) || 'postgres';
}

/** Every row in one database, classified for deciding whether it may be dropped. */
export interface DatabaseCensus {
  /** Rows in each public table. */
  tables: Record<string, number>;
  /** Rows in account-only tables (api_keys, team_members, audit_log, ...), or teams/projects rows that are not the owner's. */
  accountRows: number;
  /** Rows in data tables (sessions, events, jobs, observations, sources, job history, import batches). */
  dataRows: number;
  /** Data rows whose project_id is not the owner's. */
  foreignRows: number;
  /** Newest created_at, updated_at, or received_at in any data table, as an ISO string. */
  newestRowAt: string | null;
}

const SCHEMA_TABLES = new Set(['server_beta_schema_migrations']);
const HINGE_TABLES = new Set(['teams', 'projects']);
const DATA_TABLES = new Set([
  'server_sessions', 'agent_events', 'observation_generation_jobs', 'observations',
  'observation_sources', 'observation_generation_job_events', 'convert_import_batches',
  'memsmith_merge_provenance',
]);
const TIME_COLUMNS = ['created_at', 'updated_at', 'received_at'];
const MAINTENANCE_LOCK = 'memsmith:projects-maintenance';
// The server already holds about one connection per project database, so the
// CLI must not leave idle ones behind under Postgres's max_connections.
const IDLE_MS = 100;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class ProjectsDb {
  readonly accountDatabase: string;
  readonly base: PoolLike;
  baseProjectId: string | null = null;
  private readonly pools = new Map<string, PoolLike>();
  private readonly countErrors = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    /** False when the account database is a fallback guess rather than the running server's record. */
    readonly accountDatabaseKnown: boolean = true,
    private readonly createPool: (connectionString: string) => PoolLike = (cs) =>
      new pg.Pool({ connectionString: cs, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: IDLE_MS }) as unknown as PoolLike,
  ) {
    this.accountDatabase = databaseFromUrl(baseUrl);
    this.base = createPool(baseUrl);
    this.pools.set(this.accountDatabase, this.base);
  }

  urlFor(databaseName: string): string {
    return withDatabase(this.baseUrl, databaseName);
  }

  pool(databaseName: string): PoolLike {
    let pool = this.pools.get(databaseName);
    if (!pool) {
      pool = this.createPool(this.urlFor(databaseName));
      this.pools.set(databaseName, pool);
    }
    return pool;
  }

  /** Closes and forgets a database's pool, which DROP DATABASE requires. */
  async release(databaseName: string): Promise<void> {
    const pool = this.pools.get(databaseName);
    if (!pool || pool === this.base) return;
    this.pools.delete(databaseName);
    await pool.end().catch(() => {});
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  }

  /** Runs `fn` while holding a session advisory lock, so two merges or prunes never overlap. */
  async withMaintenanceLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.tryMaintenanceLock(fn);
    if (!result.locked) throw new Error('another memsmith merge or prune is running. Try again when it finishes.');
    return result.value;
  }

  /** Runs `fn` under the maintenance lock, or reports that another merge or prune holds it. */
  async tryMaintenanceLock<T>(fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
    const client = await this.base.connect();
    try {
      const got = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [MAINTENANCE_LOCK]);
      if (!got.rows[0]?.locked) return { locked: false };
      try {
        return { locked: true, value: await fn() };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MAINTENANCE_LOCK]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  /** Project databases closed to connections, which only an interrupted prune leaves behind. */
  async lockedDatabases(): Promise<string[]> {
    const result = await this.base.query(
      `SELECT datname FROM pg_database WHERE NOT datallowconn AND datname ~ '^msp_[0-9a-f]{32}$' ORDER BY datname`,
    );
    return result.rows.map((r) => String(r.datname));
  }

  async listDatabases(): Promise<string[]> {
    const result = await this.base.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    return result.rows.map((r) => String(r.datname));
  }

  async listProjects(): Promise<ProjectRow[]> {
    const result = await this.base.query('SELECT id, team_id, name, metadata FROM projects ORDER BY name, id');
    return result.rows.map((r) => ({
      id: String(r.id),
      teamId: String(r.team_id),
      name: String(r.name ?? r.id),
      metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    }));
  }

  async recordStats(databaseName: string, projectId: string | null): Promise<RecordStats | null> {
    const scope = projectId ? 'WHERE project_id = $1' : '';
    const and = projectId ? 'AND project_id = $1' : '';
    try {
      const result = await this.pool(databaseName).query(
        `SELECT
           (SELECT count(*) FROM observations WHERE kind <> 'user_note' ${and})::int AS observations,
           (SELECT count(*) FROM observations WHERE kind = 'user_note' ${and})::int AS notes,
           (SELECT count(*) FROM agent_events ${scope})::int AS events,
           (SELECT count(*) FROM server_sessions ${scope})::int AS sessions,
           (SELECT count(*) FROM observation_generation_jobs WHERE status = 'queued' ${and})::int AS queued_jobs,
           GREATEST(
             (SELECT max(created_at) FROM observations ${scope}),
             (SELECT max(received_at) FROM agent_events ${scope}),
             (SELECT max(updated_at) FROM server_sessions ${scope})
           ) AS last_activity`,
        projectId ? [projectId] : [],
      );
      const row = result.rows[0] ?? {};
      const last = row.last_activity;
      return {
        observations: Number(row.observations ?? 0),
        notes: Number(row.notes ?? 0),
        events: Number(row.events ?? 0),
        sessions: Number(row.sessions ?? 0),
        queuedJobs: Number(row.queued_jobs ?? 0),
        lastActivity: last ? new Date(last).toISOString() : null,
      };
    } catch (error) {
      this.countErrors.set(databaseName, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /**
   * Counts every row in every public table of `databaseName`. The owner is the
   * project the database belongs to; 'from-name' looks for the projects row
   * whose id matches an msp_ name, and with none every teams/projects row is
   * foreign. Returns null when any count fails.
   */
  async census(
    databaseName: string,
    ownerHint: { projectId: string; teamId: string } | 'from-name',
    connection?: Queryable,
  ): Promise<DatabaseCensus | null> {
    try {
      const db = connection ?? this.pool(databaseName);
      let owner: { projectId: string; teamId: string } | null = ownerHint === 'from-name' ? null : ownerHint;
      if (ownerHint === 'from-name') {
        const suffix = databaseName.replace(/^msp_/, '');
        const hinge = await db.query(
          `SELECT id, team_id FROM projects WHERE replace(id, '-', '') = $1 LIMIT 1`,
          [suffix],
        ).catch(() => ({ rows: [] as any[] }));
        if (hinge.rows[0]) owner = { projectId: String(hinge.rows[0].id), teamId: String(hinge.rows[0].team_id) };
      }
      const columns = await db.query(
        `SELECT c.table_name, c.column_name
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
      );
      const byTable = new Map<string, Set<string>>();
      for (const r of columns.rows) {
        const set = byTable.get(r.table_name) ?? new Set<string>();
        set.add(r.column_name);
        byTable.set(r.table_name, set);
      }
      const census: DatabaseCensus = { tables: {}, accountRows: 0, dataRows: 0, foreignRows: 0, newestRowAt: null };
      let newest: number | null = null;
      for (const [table, cols] of byTable) {
        const t = quoteIdent(table);
        const total = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n);
        census.tables[table] = total;
        if (total === 0 || SCHEMA_TABLES.has(table)) continue;
        if (HINGE_TABLES.has(table)) {
          const ownId = table === 'teams' ? owner?.teamId : owner?.projectId;
          const foreign = ownId
            ? Number((await db.query(`SELECT count(*)::bigint AS n FROM ${t} WHERE id <> $1`, [ownId])).rows[0].n)
            : total;
          census.accountRows += foreign;
          continue;
        }
        if (!DATA_TABLES.has(table)) {
          census.accountRows += total;
          continue;
        }
        census.dataRows += total;
        if (cols.has('project_id')) {
          census.foreignRows += owner
            ? Number((await db.query(`SELECT count(*)::bigint AS n FROM ${t} WHERE project_id IS DISTINCT FROM $1`, [owner.projectId])).rows[0].n)
            : total;
        }
        const times = TIME_COLUMNS.filter((c) => cols.has(c));
        if (times.length > 0) {
          const r = await db.query(`SELECT extract(epoch FROM GREATEST(${times.map((c) => `max(${quoteIdent(c)})`).join(', ')}))::float8 AS t FROM ${t}`);
          const at = r.rows[0]?.t;
          if (at != null) newest = Math.max(newest ?? 0, Number(at) * 1000);
        }
      }
      census.newestRowAt = newest === null ? null : new Date(newest).toISOString();
      return census;
    } catch {
      return null;
    }
  }

  /**
   * SQL that re-creates the account rows deleting `projectId` (and its team,
   * when `withTeam`) removes. Postgres quotes every value, so the file
   * restores with psql -f.
   */
  async accountRowsSql(projectId: string, teamId: string, withTeam: boolean): Promise<string> {
    const lines: string[] = ['BEGIN;'];
    const emit = async (table: string, where: string, values: unknown[]) => {
      const result = await this.base.query(
        `SELECT format('INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, %L) ON CONFLICT DO NOTHING;', row_to_json(x)::text) AS sql
           FROM ${table} x WHERE ${where}`,
        values,
      );
      for (const r of result.rows) lines.push(String(r.sql));
    };
    if (withTeam) await emit('teams', 'id = $1', [teamId]);
    await emit('projects', 'id = $1', [projectId]);
    if (withTeam) await emit('team_members', 'team_id = $1', [teamId]);
    await emit('api_keys', withTeam ? '(project_id = $1 OR team_id = $2)' : 'project_id = $1', withTeam ? [projectId, teamId] : [projectId]);
    lines.push('COMMIT;');
    return `${lines.join('\n')}\n`;
  }

  inventorySource(): InventorySource {
    return {
      accountDatabase: this.accountDatabase,
      baseProjectId: this.baseProjectId,
      listProjects: () => this.listProjects(),
      listDatabases: () => this.listDatabases(),
      recordStats: (db, projectId) => this.recordStats(db, projectId),
      countError: (db) => this.countErrors.get(db),
      release: (db) => this.release(db),
    };
  }
}

export function openLocalProjectsDb(
  env: NodeJS.ProcessEnv = process.env,
  opts: { connectTimeoutMs?: number } = {},
): ProjectsDb {
  const recorded = readRecordedAccountDatabase();
  const known = Boolean(env.MEMSMITH_SERVER_DATABASE_URL?.trim()) || recorded !== null;
  const timeout = opts.connectTimeoutMs ?? 5000;
  const db = new ProjectsDb(
    resolveLocalBaseDatabaseUrl(env, () => recorded),
    known,
    (cs) => new pg.Pool({ connectionString: cs, max: 2, connectionTimeoutMillis: timeout, idleTimeoutMillis: IDLE_MS }) as unknown as PoolLike,
  );
  db.baseProjectId = readRecordedBaseProjectId();
  return db;
}
