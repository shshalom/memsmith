import { parseArgs, styleText } from 'node:util';
import { readPluginVersion } from './utils/paths.js';
import type { InstallOptions } from './commands/install.js';

const args = process.argv.slice(2);
const firstArg = args[0]?.toLowerCase() ?? '';
// If the first token is a flag (e.g. `npx memsmith --provider claude`),
// treat the invocation as `install` with those flags. Help/version flags are
// handled directly so they don't get swallowed by the install path.
const HELP_OR_VERSION_FLAGS = new Set(['-h', '--help', '-v', '--version']);
const command =
  firstArg.startsWith('-') && !HELP_OR_VERSION_FLAGS.has(firstArg)
    ? 'install'
    : firstArg;

function printHelp(): void {
  const version = readPluginVersion();

  console.log(`
${styleText('bold', 'memsmith')} v${version} — persistent memory for AI coding assistants

${styleText('bold', 'Install Commands')} (no Bun required):
  ${styleText('cyan', 'npx memsmith')}                     Interactive install
  ${styleText('cyan', 'npx memsmith install')}              Interactive install
  ${styleText('cyan', 'npx memsmith install --ide <id>')}   Install for specific IDE
  ${styleText('cyan', 'npx memsmith install --provider claude|gemini|openrouter')}   Set LLM provider non-interactively
  ${styleText('cyan', 'npx memsmith install --model <id>')}   Set Claude model (when provider=claude)
  ${styleText('cyan', 'npx memsmith install --no-auto-start')}   Skip worker auto-start at the end
  ${styleText('cyan', 'npx memsmith install --disable-auto-memory')}   Explicitly disable Claude Code native auto-memory
  ${styleText('cyan', 'npx memsmith install --runtime worker|server')}   Select runtime non-interactively (server brings up Docker pg+redis, generates an API key, injects the IDE MCP config)
  ${styleText('cyan', 'npx memsmith install --runtime server --server-url <url>')}   Point the server runtime at a specific base URL
  ${styleText('cyan', 'npx memsmith repair')}                Repair runtime (re-runs Bun/uv setup and bun install in plugin cache)
  ${styleText('cyan', 'npx memsmith update')}               Update to latest version
  ${styleText('cyan', 'npx memsmith uninstall')}            Remove plugin and configs
  ${styleText('cyan', 'npx memsmith version')}              Print version

${styleText('bold', 'Runtime Commands')} (requires Bun, delegates to installed plugin):
  ${styleText('cyan', 'npx memsmith start')}                Start worker service
  ${styleText('cyan', 'npx memsmith stop')}                 Stop worker service
  ${styleText('cyan', 'npx memsmith restart')}              Restart worker service
  ${styleText('cyan', 'npx memsmith status')}               Show worker status
  ${styleText('cyan', 'npx memsmith doctor')}               Diagnose install/runtime health (bun, uv, worker)
  ${styleText('cyan', 'npx memsmith telemetry status|enable|disable')}   Manage anonymous telemetry (on by default, opt-out)
  ${styleText('cyan', 'npx memsmith server start')}         Start server service
  ${styleText('cyan', 'npx memsmith server stop')}          Stop server service
  ${styleText('cyan', 'npx memsmith server restart')}       Restart server service
  ${styleText('cyan', 'npx memsmith server status')}        Show server status
  ${styleText('cyan', 'npx memsmith server api-key create|list|revoke')}   Manage API keys
  ${styleText('cyan', 'npx memsmith worker start|stop|restart|status')}    Worker compatibility aliases
  ${styleText('cyan', 'npx memsmith search <query>')}       Search observations
  ${styleText('cyan', 'npx memsmith adopt [--dry-run] [--branch <name>]')}    Stamp merged worktrees into parent project
  ${styleText('cyan', 'npx memsmith cleanup [--dry-run]')}    Run one-time v12.4.3 pollution cleanup (or preview counts)
  ${styleText('cyan', 'npx memsmith transcript watch')}     Start transcript watcher
  ${styleText('cyan', 'npx memsmith antigravity-cli install|status|uninstall')}   Manage Antigravity CLI hooks + MCP config

${styleText('bold', 'IDE Identifiers')}:
  claude-code, cursor, opencode, openclaw,
  windsurf, codex-cli, copilot-cli, antigravity, goose,
  roo-code, warp
`);
}

function parseInstallOptions(argv: string[]): InstallOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      ide: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      runtime: { type: 'string' },
      'server-url': { type: 'string' },
      'no-auto-start': { type: 'boolean' },
      'disable-auto-memory': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  const flag = (name: string): string | undefined =>
    typeof values[name] === 'string' ? (values[name] as string) : undefined;
  const provider = flag('provider');
  if (provider !== undefined && provider !== 'claude' && provider !== 'gemini' && provider !== 'openrouter' && provider !== 'ollama') {
    console.error(`Unknown --provider: ${provider}. Allowed: claude, gemini, openrouter, ollama`);
    process.exit(1);
  }
  const runtime = flag('runtime');
  if (runtime !== undefined && runtime !== 'worker' && runtime !== 'server' && runtime !== 'server-beta') {
    console.error(`Unknown --runtime: ${runtime}. Allowed: worker, server`);
    process.exit(1);
  }
  return {
    ide: flag('ide'),
    provider: provider as InstallOptions['provider'],
    model: flag('model'),
    noAutoStart: values['no-auto-start'] === true,
    disableAutoMemory: values['disable-auto-memory'] === true,
    runtime: runtime as InstallOptions['runtime'],
    serverUrl: flag('server-url'),
  };
}

async function main(): Promise<void> {
  switch (command) {
    case '':
    case 'install': {
      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand(parseInstallOptions(args));
      break;
    }

    case 'repair': {
      const { runRepairCommand } = await import('./commands/install.js');
      await runRepairCommand();
      break;
    }

    case 'update':
    case 'upgrade': {
      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand();
      break;
    }

    case 'uninstall':
    case 'remove': {
      const { runUninstallCommand } = await import('./commands/uninstall.js');
      await runUninstallCommand();
      break;
    }

    case 'version':
    case '--version':
    case '-v': {
      console.log(readPluginVersion());
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      break;
    }

    case 'start': {
      const { runStartCommand } = await import('./commands/runtime.js');
      runStartCommand();
      break;
    }
    case 'stop': {
      const { runStopCommand } = await import('./commands/runtime.js');
      runStopCommand();
      break;
    }
    case 'restart': {
      const { runRestartCommand } = await import('./commands/runtime.js');
      runRestartCommand();
      break;
    }
    case 'status': {
      const { runStatusCommand } = await import('./commands/runtime.js');
      runStatusCommand();
      break;
    }

    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand();
      break;
    }

    case 'telemetry': {
      const { runTelemetryCommand } = await import('./commands/telemetry.js');
      await runTelemetryCommand(args.slice(1));
      break;
    }

    // The non-gated escape hatch for memory-first enforcement. Runs in the user's
    // shell, so it still works while hard mode is denying tool calls.
    case 'enforcement': {
      const { runEnforcementCommand } = await import('./commands/enforcement.js');
      runEnforcementCommand(args.slice(1));
      break;
    }

    case 'server': {
      const { runServerCommand } = await import('./commands/server.js');
      await runServerCommand(args.slice(1));
      break;
    }

    case 'antigravity-cli': {
      const { handleAntigravityCliCommand } = await import('../services/integrations/AntigravityCliHooksInstaller.js');
      const exitCode = await handleAntigravityCliCommand(args[1]?.toLowerCase(), args.slice(2));
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
      break;
    }

    case 'worker': {
      const { runWorkerAliasCommand } = await import('./commands/server.js');
      runWorkerAliasCommand(args.slice(1));
      break;
    }

    case 'search': {
      const { runSearchCommand } = await import('./commands/runtime.js');
      await runSearchCommand(args.slice(1));
      break;
    }

    case 'adopt': {
      const { runAdoptCommand } = await import('./commands/runtime.js');
      runAdoptCommand(args.slice(1));
      break;
    }

    case 'cleanup': {
      const { runCleanupCommand } = await import('./commands/runtime.js');
      runCleanupCommand(args.slice(1));
      break;
    }

    case 'transcript': {
      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'watch') {
        const { runTranscriptWatchCommand } = await import('./commands/runtime.js');
        runTranscriptWatchCommand();
      } else {
        console.error(styleText('red', `Unknown transcript subcommand: ${subCommand ?? '(none)'}`));
        console.error(`Usage: npx memsmith transcript watch`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(styleText('red', `Unknown command: ${command}`));
      console.error(`Run ${styleText('bold', 'npx memsmith --help')} for usage information.`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(styleText('red', 'Fatal error:'), error.message || error);
  process.exit(1);
});
