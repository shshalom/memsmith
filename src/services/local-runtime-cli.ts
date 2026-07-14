// SPDX-License-Identifier: Apache-2.0
// The `local` runtime CLI (start|stop|status|restart), extracted from
// worker-service.ts so it survives worker retirement. Boots the embedded
// Postgres runtime via startLocalRuntime().

const LOCAL_ALIASES = new Set(['start', 'stop', 'status', 'restart']);

export function parseLocalCommand(
  rawCommand: string,
  maybeSubCommand: string | undefined,
  rest: string[],
): { command: string; args: string[] } | null {
  if (rawCommand !== 'local') return null;
  return {
    command: maybeSubCommand && LOCAL_ALIASES.has(maybeSubCommand) ? `local-${maybeSubCommand}` : 'local-help',
    args: rest,
  };
}

export async function runLocalCommand(command: string, _args: string[]): Promise<void> {
  switch (command) {
    case 'local-start': {
      process.env.MEMSMITH_RUNTIME = 'local';
      const { startLocalRuntime } = await import('../server/runtime/local-runtime.js');
      await startLocalRuntime(); // blocks in the foreground server loop
      return;
    }
    case 'local-stop': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      await new EmbeddedPostgresManager().stop();
      console.log('Local embedded Postgres stopped.');
      return;
    }
    case 'local-status': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      const running = new EmbeddedPostgresManager().isRunning();
      console.log(running ? 'Local embedded Postgres: RUNNING' : 'Local embedded Postgres: stopped');
      return;
    }
    case 'local-restart': {
      const { EmbeddedPostgresManager } = await import('../server/runtime/EmbeddedPostgresManager.js');
      await new EmbeddedPostgresManager().stop();
      process.env.MEMSMITH_RUNTIME = 'local';
      const { startLocalRuntime } = await import('../server/runtime/local-runtime.js');
      await startLocalRuntime();
      return;
    }
    case 'local-help':
    default:
      console.error('Usage: memsmith local start|stop|status|restart');
      process.exit(1);
  }
}
