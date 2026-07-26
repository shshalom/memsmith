// SPDX-License-Identifier: Apache-2.0
import pg from 'pg';
import { EmbeddedPostgresManager } from './EmbeddedPostgresManager.js';
import { readProjectMarker, writeProjectDatabaseName } from '../../services/identity/project-identity.js';
import { resolveProjectDatabaseName, ensureDatabaseExists } from './resolve-project-database.js';
import { logger } from '../../utils/logger.js';

export interface StartLocalRuntimeOptions {
  manager?: EmbeddedPostgresManager;
  // Injectable so tests don't boot the HTTP server. Defaults to the real
  // server foreground runner.
  startService?: (connectionString: string) => Promise<void>;
  // Injectable first-run importer. Defaults to wiring the real importer
  // (SQLite reader + PG inserter + Ollama classifier + embedding backfill).
  // Runs after env vars are set, before the service starts. Best-effort:
  // failures are logged and never block service start.
  runImport?: (connectionString: string) => Promise<void>;
  // Injectable per-project DB resolver. Defaults to defaultResolveDatabaseUrl,
  // which builds an admin pg.Pool on the base `postgres` URL, resolves the
  // project database name, creates it if needed, and returns the project-scoped
  // URL. Tests inject `async (c) => c` (passthrough) to stay hermetic.
  resolveDatabaseUrl?: (baseConnectionString: string, cwd: string) => Promise<string>;
}

export async function startLocalRuntime(
  options: StartLocalRuntimeOptions = {},
): Promise<{ connectionString: string }> {
  const manager = options.manager ?? new EmbeddedPostgresManager();
  const { connectionString, reused } = await manager.start();
  const resolveDatabaseUrl = options.resolveDatabaseUrl ?? defaultResolveDatabaseUrl;
  process.env.MEMSMITH_SERVER_DATABASE_URL = await resolveDatabaseUrl(
    connectionString,
    process.env.MEMSMITH_PROJECT_CWD ?? process.cwd(),
  );
  if (!(process.env.MEMSMITH_QUEUE_ENGINE ?? '').trim()) {
    process.env.MEMSMITH_QUEUE_ENGINE = 'inline';
  }
  logger.info('SYSTEM', 'local runtime: embedded PG ready', { reused });
  const runImport = options.runImport ?? defaultRunImport;
  try {
    await runImport(connectionString);
  } catch (error) {
    logger.warn(
      'SYSTEM',
      'local first-run import failed (non-fatal; will retry next boot)',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  const start = options.startService ?? defaultStartService;
  await start(connectionString);
  return { connectionString };
}

async function defaultResolveDatabaseUrl(baseConnectionString: string, cwd: string): Promise<string> {
  // baseConnectionString targets `postgres` (the maintenance DB). Use it to
  // resolve the per-project DB, create it if needed, then return the
  // project-scoped URL. Never leaves the runtime on the shared `postgres` DB
  // for a non-legacy project.
  const adminPool = new pg.Pool({ connectionString: baseConnectionString, max: 2 });
  try {
    const dbName = await resolveProjectDatabaseName({
      cwd,
      readMarker: readProjectMarker,
      writeName: writeProjectDatabaseName,
      probeHasProjectRows: async (projectId) => {
        try {
          const r = await adminPool.query('SELECT 1 FROM observations WHERE project_id = $1 LIMIT 1', [projectId]);
          return r.rows.length > 0;
        } catch { return false; } // fresh postgres DB has no observations table yet
      },
      databaseExists: async (name) => {
        const r = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        return r.rows.length > 0;
      },
    });
    await ensureDatabaseExists((t, p) => adminPool.query(t, p as unknown[]), dbName);
    // Rebuild the URL with the project DB name. Parse the base URL and swap the
    // path segment (host/port/creds unchanged).
    const u = new URL(baseConnectionString);
    u.pathname = '/' + dbName;
    return u.toString();
  } finally {
    await adminPool.end();
  }
}

async function defaultRunImport(_connectionString: string): Promise<void> {
  const { existsSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const home = join(homedir(), '.memsmith');
  const sqlitePath = join(home, 'memsmith.db');
  const markerPath = join(home, '.local-import-done');

  const { getSharedPostgresPool } = await import('../../storage/postgres/pool.js');
  const { bootstrapServerPostgresSchema } = await import('../../storage/postgres/schema.js');
  const { loadServerMode } = await import('./create-server-service.js');
  const { runFirstRunImport } = await import('./import/firstRunImport.js');
  const { buildOllamaClassifier } = await import('./import/ollamaClassifier.js');
  const { readWorkerObservations } = await import('./import/sqliteReader.js');

  // Load the active mode BEFORE the import so loadCanonicalTypeIds() returns the
  // real 8-type taxonomy (bugfix/feature/refactor/change/discovery/decision/...),
  // not the 4-item fallback. Otherwise most rows look "non-canonical" and hit the
  // Ollama classifier per row — which serializes on the model and can wedge the
  // import. With the real taxonomy, these source types fast-path (no model call).
  try {
    loadServerMode();
  } catch (error) {
    logger.warn('SYSTEM', 'could not load mode before import; taxonomy falls back', {}, error instanceof Error ? error : new Error(String(error)));
  }

  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });

  // The import runs BEFORE createServerService (which normally bootstraps the
  // schema), so on a fresh embedded PG the tables don't exist yet. Bootstrap
  // here first — it is idempotent (CREATE TABLE IF NOT EXISTS throughout), so
  // createServerService re-running it afterward is a safe no-op.
  await bootstrapServerPostgresSchema(pool);

  // Resolve scope: env > marker > mint (minting needs the pool + schema to exist,
  // which is why this call is placed AFTER getSharedPostgresPool + bootstrapServerPostgresSchema).
  const { resolveLocalScope } = await import('./resolve-local-scope.js');
  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  const { teamId, projectId } = await resolveLocalScope({ cwd, pool });

  // The observations table requires a team + project (both NOT NULL, FK). Ensure
  // fixed local rows exist so inserts don't violate the FK. Idempotent.
  await pool.query('INSERT INTO teams (id, name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [teamId]);
  await pool.query(
    'INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
    [projectId, teamId],
  );

  const inserted: string[] = [];
  const result = await runFirstRunImport({
    sqliteExists: () => existsSync(sqlitePath),
    markerExists: () => existsSync(markerPath),
    // Fixed literal — a static marker is fine and avoids Date.now()/new Date()
    // which are unavailable in some execution contexts.
    writeMarker: () => writeFileSync(markerPath, 'done', 'utf8'),
    observationsEmpty: async () => {
      const r = await pool.query('SELECT count(*)::int AS n FROM observations');
      return ((r.rows[0] as { n?: number } | undefined)?.n ?? 0) === 0;
    },
    readSourceRows: () => readWorkerObservations(sqlitePath),
    insertRow: async (row) => {
      await pool.query(
        `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content)
         VALUES ($1,$2,$3,'observation',$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [row.id, teamId, projectId, row.obsType, row.obsType === 'decision' ? 'active' : 'resolved', row.content],
      );
      inserted.push(row.id);
    },
    // Batch insert: one multi-row INSERT per ~200 rows instead of a round-trip
    // per row. This is what makes the ~2.7k-row import complete in seconds.
    // 6 bound params per row (kind is a SQL literal).
    insertBatch: async (rows) => {
      const tuples: string[] = [];
      const values: unknown[] = [];
      rows.forEach((row, j) => {
        const b = j * 6;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},'observation',$${b + 4},$${b + 5},$${b + 6})`);
        values.push(
          row.id,
          teamId,
          projectId,
          row.obsType,
          row.obsType === 'decision' ? 'active' : 'resolved',
          row.content,
        );
      });
      await pool.query(
        `INSERT INTO observations (id, team_id, project_id, kind, obs_type, lifecycle_state, content)
         VALUES ${tuples.join(',')} ON CONFLICT (id) DO NOTHING`,
        values,
      );
      for (const row of rows) inserted.push(row.id);
    },
    classifier: buildOllamaClassifier(),
  });

  // Embedding backfill so semantic search works immediately after import.
  // Best-effort: any failure is logged and never propagates out of the import.
  if (!result.skipped && result.imported > 0) {
    try {
      const { embed } = await import('../generation/embedder.js');
      const pending = await pool.query<{ id: string; content: string }>(
        'SELECT id, content FROM observations WHERE embedding_vec IS NULL',
      );
      logger.info('SYSTEM', 'embedding backfill starting', { rows: pending.rows.length });
      let done = 0;
      for (const r of pending.rows) {
        try {
          const vec = await embed(r.content || ' ');
          const literal = '[' + vec.join(',') + ']';
          await pool.query(
            'UPDATE observations SET embedding_vec = $1::public.vector WHERE id = $2 AND embedding_vec IS NULL',
            [literal, r.id],
          );
        } catch (rowError) {
          logger.warn(
            'SYSTEM',
            'embedding backfill failed for row',
            { id: r.id },
            rowError instanceof Error ? rowError : new Error(String(rowError)),
          );
        }
        done += 1;
        if (done % 500 === 0) {
          logger.info('SYSTEM', 'embedding backfill progress', { done, total: pending.rows.length });
        }
      }
      logger.info('SYSTEM', 'embedding backfill complete', { done });
    } catch (error) {
      logger.warn(
        'SYSTEM',
        'embedding backfill unavailable (non-fatal)',
        {},
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

async function defaultStartService(_connectionString: string): Promise<void> {
  // Reuse the existing server foreground loop; it reads MEMSMITH_SERVER_DATABASE_URL
  // (which we just set) and installs signal handlers + createServerService.
  const { runServerForegroundForLocal } = await import('./ServerService.js');
  await runServerForegroundForLocal();
}
