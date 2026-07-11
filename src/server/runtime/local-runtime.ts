// SPDX-License-Identifier: Apache-2.0
import { EmbeddedPostgresManager } from './EmbeddedPostgresManager.js';
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
}

export async function startLocalRuntime(
  options: StartLocalRuntimeOptions = {},
): Promise<{ connectionString: string }> {
  const manager = options.manager ?? new EmbeddedPostgresManager();
  const { connectionString, reused } = await manager.start();
  process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString;
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

async function defaultRunImport(_connectionString: string): Promise<void> {
  const { existsSync, writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const home = join(homedir(), '.memsmith');
  const sqlitePath = join(home, 'memsmith.db');
  const markerPath = join(home, '.local-import-done');

  const teamId = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim() || 'local';
  const projectId = (process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID ?? '').trim() || 'local';

  const { getSharedPostgresPool } = await import('../../storage/postgres/pool.js');
  const { runFirstRunImport } = await import('./import/firstRunImport.js');
  const { buildOllamaClassifier } = await import('./import/ollamaClassifier.js');
  const { readWorkerObservations } = await import('./import/sqliteReader.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });

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
      }
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
