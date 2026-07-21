// SPDX-License-Identifier: Apache-2.0
import { parsePostgresConfig } from '../../storage/postgres/config.js';
import { createPostgresPool } from '../../storage/postgres/pool.js';

export interface ProbeResult {
  connectivity: { reachable: boolean; authenticates: boolean };
  fitness: { writable: boolean; pgvector: boolean; versionOk: boolean; schemaReady: boolean };
  allGreen: boolean;
  fixable: string[];
  error?: string;
}
export interface ProbeDeps {
  runQuery: (url: string, sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}
export const MIN_PG_MAJOR = 14;

function looksLikeAuthError(msg: string): boolean {
  return /password|authentication|role .* does not exist|permission denied/i.test(msg);
}

export async function probeConnection(url: string, deps: ProbeDeps): Promise<ProbeResult> {
  const result: ProbeResult = {
    connectivity: { reachable: false, authenticates: false },
    fitness: { writable: false, pgvector: false, versionOk: false, schemaReady: false },
    allGreen: false,
    fixable: [],
  };
  try {
    await deps.runQuery(url, 'SELECT 1');
    result.connectivity.reachable = true;
    result.connectivity.authenticates = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.error = msg;
    result.connectivity.reachable = looksLikeAuthError(msg); // reachable but auth failed
    result.connectivity.authenticates = false;
    return result;
  }

  // version
  try {
    const v = await deps.runQuery(url, 'SHOW server_version_num');
    const num = Number.parseInt(String(v.rows[0]?.server_version_num ?? '0'), 10);
    result.fitness.versionOk = Number.isFinite(num) && num >= MIN_PG_MAJOR * 10000;
  } catch { result.fitness.versionOk = false; }

  // writable
  try {
    await deps.runQuery(url, 'CREATE TEMP TABLE _ms_probe(x int); DROP TABLE _ms_probe');
    result.fitness.writable = true;
  } catch { result.fitness.writable = false; }

  // pgvector
  try {
    const installed = await deps.runQuery(url, "SELECT extname FROM pg_extension WHERE extname='vector'");
    if (installed.rows.length > 0) {
      result.fitness.pgvector = true;
    } else {
      const available = await deps.runQuery(url, "SELECT name FROM pg_available_extensions WHERE name='vector'");
      if (available.rows.length > 0) result.fixable.push('pgvector');
    }
  } catch { /* leave pgvector false */ }

  // schema-ready: observations absent (fresh) OR present (compatible upsert target)
  try {
    await deps.runQuery(url, "SELECT 1 FROM information_schema.tables WHERE table_name='observations'");
    result.fitness.schemaReady = true; // absent→fresh (ok), present→compatible (ok); both upsertable
  } catch { result.fitness.schemaReady = false; }

  result.allGreen =
    result.connectivity.reachable && result.connectivity.authenticates &&
    result.fitness.writable && result.fitness.pgvector &&
    result.fitness.versionOk && result.fitness.schemaReady;
  return result;
}

export function makeRealProbeDeps(): ProbeDeps {
  return {
    runQuery: async (url, sql) => {
      const config = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: url } as NodeJS.ProcessEnv });
      if (!config) throw new Error('invalid connection string');
      const pool = createPostgresPool(config);
      try {
        const res = await pool.query(sql);
        return { rows: (res.rows ?? []) as Array<Record<string, unknown>> };
      } finally {
        await pool.end();
      }
    },
  };
}
