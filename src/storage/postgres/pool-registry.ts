// SPDX-License-Identifier: Apache-2.0
//
// PoolRegistry — per-database connection-pool registry. Provisions a
// project's database on first touch (create DB, connect, bootstrap schema,
// seed hinge rows), then caches the pool for subsequent requests. The base
// database (the live dogfood DB) is never provisioned; its pool is owned and
// supplied by the server. See
// docs/superpowers/specs/2026-07-24-local-database-per-project-design.md.
import type { PostgresPool } from './pool.js';
import { ensureDatabaseExists } from '../../server/runtime/resolve-project-database.js';

export interface PoolRegistryDeps {
  baseConnectionString: string;
  basePool: PostgresPool; // the cold-boot/base DB pool
  baseDatabaseName: string; // e.g. 'postgres'
  createPool: (connectionString: string) => PostgresPool;
  adminQuery: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  bootstrapProject: (pool: PostgresPool) => Promise<void>;
  seedHinge: (pool: PostgresPool, ids: { teamId: string; projectId: string }) => Promise<void>;
}

function withDatabaseName(baseConnectionString: string, databaseName: string): string {
  const u = new URL(baseConnectionString);
  u.pathname = '/' + databaseName;
  return u.toString();
}

export class PoolRegistry {
  private readonly pools = new Map<string, Promise<PostgresPool>>();

  constructor(private readonly deps: PoolRegistryDeps) {}

  async getPool(databaseName: string, ids: { teamId: string; projectId: string }): Promise<PostgresPool> {
    if (databaseName === this.deps.baseDatabaseName) return this.deps.basePool;

    const cached = this.pools.get(databaseName);
    if (cached) return cached;

    const provisioning = this.provision(databaseName, ids).catch((err) => {
      this.pools.delete(databaseName);
      throw err;
    });
    this.pools.set(databaseName, provisioning);
    return provisioning;
  }

  private async provision(
    databaseName: string,
    ids: { teamId: string; projectId: string },
  ): Promise<PostgresPool> {
    await ensureDatabaseExists(this.deps.adminQuery, databaseName);
    const pool = this.deps.createPool(withDatabaseName(this.deps.baseConnectionString, databaseName));
    await this.deps.bootstrapProject(pool);
    await this.deps.seedHinge(pool, ids);
    return pool;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    for (const p of pending) {
      const pool = await p.catch(() => null);
      if (pool && pool !== this.deps.basePool) {
        await (pool as unknown as { end: () => Promise<void> }).end();
      }
    }
  }
}
