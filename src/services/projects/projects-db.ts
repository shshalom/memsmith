// SPDX-License-Identifier: Apache-2.0
//
// Direct connection to the local runtime's embedded Postgres, the same way the
// hooks mint identities (local-base-dsn.ts) and `memsmith server jobs` reads
// the queue. Listing and merging span every project database, including
// databases no projects row names, which no per-project HTTP route can reach.
import pg from 'pg';
import { readRecordedAccountDatabase, resolveLocalBaseDatabaseUrl } from '../identity/local-base-dsn.js';
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

export class ProjectsDb {
  readonly accountDatabase: string;
  readonly base: PoolLike;
  private readonly pools = new Map<string, PoolLike>();

  constructor(
    private readonly baseUrl: string,
    private readonly createPool: (connectionString: string) => PoolLike = (cs) => new pg.Pool({ connectionString: cs, max: 2 }) as unknown as PoolLike,
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
        lastActivity: last ? new Date(last).toISOString() : null,
      };
    } catch {
      return null;
    }
  }

  inventorySource(): InventorySource {
    return {
      accountDatabase: this.accountDatabase,
      listProjects: () => this.listProjects(),
      listDatabases: () => this.listDatabases(),
      recordStats: (db, projectId) => this.recordStats(db, projectId),
    };
  }
}

export function openLocalProjectsDb(env: NodeJS.ProcessEnv = process.env): ProjectsDb {
  return new ProjectsDb(resolveLocalBaseDatabaseUrl(env, readRecordedAccountDatabase));
}
