// SPDX-License-Identifier: Apache-2.0
import { EmbeddedPostgresManager } from './EmbeddedPostgresManager.js';
import { logger } from '../../utils/logger.js';

export interface StartLocalRuntimeOptions {
  manager?: EmbeddedPostgresManager;
  // Injectable so tests don't boot the HTTP server. Defaults to the real
  // server foreground runner.
  startService?: (connectionString: string) => Promise<void>;
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
  const start = options.startService ?? defaultStartService;
  await start(connectionString);
  return { connectionString };
}

async function defaultStartService(_connectionString: string): Promise<void> {
  // Reuse the existing server foreground loop; it reads MEMSMITH_SERVER_DATABASE_URL
  // (which we just set) and installs signal handlers + createServerService.
  const { runServerForegroundForLocal } = await import('./ServerService.js');
  await runServerForegroundForLocal();
}
