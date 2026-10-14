import { styleText } from 'node:util';
import { readFlatSettings } from '../../shared/flat-settings.js';
import { runServerApiKeyCommand, runServerWorkerStartCommand } from './runtime.js';
import { runLifecycle, type LifecycleCommand, type LifecycleDeps } from './lifecycle.js';

const LIFECYCLE = new Set<string>(['start', 'stop', 'restart', 'status']);

function printServerUsage(): void {
  console.error(`Usage: ${styleText('bold', 'memsmith server <command>')}`);
  console.error('Commands: start [--timeout <s>], stop [--all], restart [--timeout <s>], status, api-key create|list|revoke, keys rotate, worker start, jobs status|failed|retry|cancel');
}

export async function routeLifecycle(
  namespace: 'top' | 'server' | 'worker',
  argv: string[],
  deps?: LifecycleDeps,
): Promise<number | null> {
  const sub = argv[0]?.toLowerCase();
  if (!sub || !LIFECYCLE.has(sub)) return null;
  if (namespace === 'worker') {
    console.error(styleText('yellow', `\`memsmith worker\` is deprecated; use \`memsmith ${sub}\`.`));
  }
  return runLifecycle(sub as LifecycleCommand, argv.slice(1), deps);
}

export async function runServerCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand) {
    printServerUsage();
    process.exit(1);
  }

  const lifecycleCode = await routeLifecycle('server', argv);
  if (lifecycleCode !== null) process.exit(lifecycleCode);

  if (subCommand === 'api-key') {
    const apiKeyCommand = argv[1]?.toLowerCase();
    if (apiKeyCommand === 'create' || apiKeyCommand === 'list' || apiKeyCommand === 'revoke') {
      runServerApiKeyCommand(argv.slice(1));
      return;
    }
    console.error(styleText('red', `Unknown server api-key subcommand: ${apiKeyCommand ?? '(none)'}`));
    console.error('Usage: npx memsmith server api-key create|list|revoke');
    process.exit(1);
  }

  if (subCommand === 'worker') {
    const workerCommand = argv[1]?.toLowerCase();
    if (workerCommand === 'start') {
      runServerWorkerStartCommand();
      return;
    }
    console.error(styleText('red', `Unknown server worker subcommand: ${workerCommand ?? '(none)'}`));
    console.error('Usage: npx memsmith server worker start');
    process.exit(1);
  }

  if (subCommand === 'keys') {
    const keysCommand = argv[1]?.toLowerCase();
    if (keysCommand === 'rotate') {
      await runServerKeysRotateCommand();
      return;
    }
    console.error(styleText('red', `Unknown server keys subcommand: ${keysCommand ?? '(none)'}`));
    console.error('Usage: npx memsmith server keys rotate');
    process.exit(1);
  }

  if (subCommand === 'jobs') {
    // Phase 12 — operator queue console. Uses Postgres (canonical) +
    // BullMQ (transport) directly. See src/npx-cli/commands/server-jobs.ts.
    const { runServerJobsCommand } = await import('./server-jobs.js');
    await runServerJobsCommand(argv.slice(1));
    return;
  }

  console.error(styleText('red', `Unknown server command: ${subCommand}`));
  printServerUsage();
  process.exit(1);
}

async function runServerKeysRotateCommand(): Promise<void> {
  if (!process.env.MEMSMITH_SERVER_DATABASE_URL) {
    console.error(styleText('red', 'Cannot rotate server API key: MEMSMITH_SERVER_DATABASE_URL is not set.'));
    console.error('Configure Postgres first, then re-run this command.');
    process.exit(1);
  }
  const { rotateServerApiKey, persistServerSettings } = await import(
    '../../services/hooks/server-bootstrap.js'
  );
  const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
  const { join } = await import('path');

  const settingsPath = join(SettingsDefaultsManager.get('MEMSMITH_DATA_DIR'), 'settings.json');
  let previousApiKeyId: string | null = null;
  try {
    const flat = readFlatSettings(settingsPath);
    // Phase 1d: read the new canonical key first, fall back to the
    // legacy `MEMSMITH_SERVER_BETA_API_KEY` so rotations work for
    // both fresh installs and pre-rename installs.
    const previousKey = flat?.MEMSMITH_SERVER_API_KEY ?? flat?.MEMSMITH_SERVER_BETA_API_KEY;
    if (typeof previousKey === 'string' && previousKey.length > 0) {
      previousApiKeyId = await lookupApiKeyIdByPlaintext(previousKey);
    }
  } catch {
    // ignore — we'll just generate a new key without revoking the old one
  }

  const result = await rotateServerApiKey({ previousApiKeyId });
  persistServerSettings(settingsPath, {
    apiKey: result.rawKey,
    projectId: result.projectId,
  });
  console.log(JSON.stringify({
    rotated: true,
    apiKeyId: result.apiKeyId,
    teamId: result.teamId,
    projectId: result.projectId,
    settingsPath,
  }, null, 2));
}

async function lookupApiKeyIdByPlaintext(rawKey: string): Promise<string | null> {
  const { createPostgresPool } = await import('../../storage/postgres/pool.js');
  const { parsePostgresConfig } = await import('../../storage/postgres/config.js');
  const { hashApiKey } = await import('../../services/hooks/server-bootstrap.js');
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) return null;
  const pool = createPostgresPool(config);
  try {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE key_hash = $1 LIMIT 1',
      [hashApiKey(rawKey)],
    );
    return result.rows[0]?.id ?? null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function runWorkerAliasCommand(argv: string[] = []): Promise<void> {
  const code = await routeLifecycle('worker', argv);
  if (code === null) {
    console.error(styleText('red', `Unknown worker command: ${argv[0] ?? '(none)'}`));
    console.error('Usage: memsmith worker start|stop|restart|status');
    process.exit(1);
  }
  process.exit(code);
}
