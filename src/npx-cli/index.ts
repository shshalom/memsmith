import { parseArgs, styleText } from 'node:util';
import { readPluginVersion } from './utils/paths.js';
import { exitAfterFlush } from './utils/exit.js';
import type { InstallOptions } from './commands/install.js';
import { normalizeRuntimeFlag } from './commands/server-runtime-setup.js';

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
  ${styleText('cyan', 'npx memsmith install --provider ollama|claude|gemini|openrouter')}   Set the generation provider (default: claude) without the prompt
  ${styleText('cyan', 'npx memsmith install --model <id>')}   Set the generation model for the chosen provider
  ${styleText('cyan', 'npx memsmith install --setup-ollama')}   Install Ollama, start it, and download its model without asking
  ${styleText('cyan', 'npx memsmith install --provider claude --local-backup')}   Also install the local Ollama backup that takes over when Claude is unavailable
  ${styleText('cyan', 'npx memsmith install --no-auto-start')}   Skip server auto-start at the end
  ${styleText('cyan', 'npx memsmith install --start-at-login')}   Start MemSmith when you log in, without asking (--no-start-at-login skips)
  ${styleText('cyan', 'npx memsmith install --disable-auto-memory')}   Explicitly disable Claude Code native auto-memory
  ${styleText('cyan', 'npx memsmith install --runtime local|server')}   Select runtime non-interactively (local: embedded Postgres, the default; server: a team MemSmith server)
  ${styleText('cyan', 'npx memsmith install --runtime server --server-url <url>')}   Point the server runtime at a specific base URL
  ${styleText('cyan', 'npx memsmith repair')}                Repair runtime (re-runs Bun/uv setup and bun install in plugin cache)
  ${styleText('cyan', 'npx memsmith@latest update')}        Update the CLI, plugin, and server to the latest version (keeps your settings)
  ${styleText('cyan', 'npx memsmith uninstall')}            Remove plugin and configs
  ${styleText('cyan', 'npx memsmith version')}              Print version

${styleText('bold', 'Memory Commands')} (run from a project folder; need the server running):
  ${styleText('cyan', 'memsmith search <query> [--actor <name>] [--limit <n>] [--json]')}   Search this project's memory
  ${styleText('cyan', 'memsmith get <id> [<id>...] [--json]')}   Show full observations by id
  ${styleText('cyan', 'memsmith note <text> [--json]')}     Save a user note for this project (- reads the text from stdin)
  ${styleText('cyan', 'memsmith project')}                  Show which project this folder uses, and why
  ${styleText('cyan', 'memsmith link [<id>|<name>|<path>] [--new] [--force]')}   Pin this folder to a project
  ${styleText('cyan', 'memsmith projects [--json]')}         List every local project, its folders, records, and flags
  ${styleText('cyan', 'memsmith projects --prune [--yes]')}  Remove orphan databases and empty or merged projects, after a backup
  ${styleText('cyan', 'memsmith merge <from> <into> [--yes]')}   Fold one local project's records into another (preview without --yes)

${styleText('bold', 'Server Commands')} (requires Bun, delegates to installed plugin):
  ${styleText('cyan', 'memsmith start [--timeout <s>]')}    Start the local server and wait until it is ready
  ${styleText('cyan', 'memsmith stop [--all]')}             Stop the server (--all also stops embedded Postgres)
  ${styleText('cyan', 'memsmith restart [--timeout <s>]')}  Restart the server
  ${styleText('cyan', 'memsmith status')}                   Show server status (exit 1 when not running)
  ${styleText('cyan', 'memsmith doctor [--fix]')}           Diagnose, and optionally repair, the install
  ${styleText('cyan', 'memsmith server api-key create|list|revoke')}   Manage API keys
  ${styleText('cyan', 'memsmith autostart enable|disable|status')}   Start MemSmith when you log in
  ${styleText('cyan', 'npx memsmith telemetry status|enable|disable')}   Manage anonymous telemetry (off unless MEMSMITH_TELEMETRY_KEY is set)
  ${styleText('cyan', 'npx memsmith transcript watch')}     Start transcript watcher
  ${styleText('cyan', 'npx memsmith antigravity-cli install|status|uninstall')}   Manage Antigravity CLI hooks + MCP config

${styleText('bold', 'IDE Identifiers')}:
  claude-code, cursor, opencode, windsurf,
  codex-cli, copilot-cli, antigravity, goose,
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
      'setup-ollama': { type: 'boolean' },
      'local-backup': { type: 'boolean' },
      'start-at-login': { type: 'boolean' },
      'no-start-at-login': { type: 'boolean' },
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
  if (runtime !== undefined && normalizeRuntimeFlag(runtime) === null) {
    console.error(`Unknown --runtime: ${runtime}. Allowed: local, server`);
    process.exit(1);
  }
  return {
    ide: flag('ide'),
    provider: provider as InstallOptions['provider'],
    model: flag('model'),
    noAutoStart: values['no-auto-start'] === true,
    disableAutoMemory: values['disable-auto-memory'] === true,
    setupOllama: values['setup-ollama'] === true,
    localBackup: values['local-backup'] === true ? true : undefined,
    startAtLogin: values['no-start-at-login'] === true ? false : values['start-at-login'] === true ? true : undefined,
    runtime,
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
      const { runUpdate } = await import('./commands/update.js');
      await exitAfterFlush(await runUpdate(args.slice(1)));
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

    case 'start':
    case 'stop':
    case 'restart':
    case 'status': {
      const { routeLifecycle } = await import('./commands/server.js');
      await exitAfterFlush((await routeLifecycle('top', args)) ?? 1);
    }

    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand(args.slice(1));
      break;
    }

    case 'autostart': {
      const { runAutostartCommand } = await import('./commands/autostart.js');
      await exitAfterFlush(await runAutostartCommand(args.slice(1)));
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
        await exitAfterFlush(exitCode);
      }
      break;
    }

    case 'worker': {
      const { runWorkerAliasCommand } = await import('./commands/server.js');
      await runWorkerAliasCommand(args.slice(1));
      break;
    }

    case 'search': {
      const { runMemorySearch } = await import('./commands/memory.js');
      await exitAfterFlush(await runMemorySearch(args.slice(1)));
    }

    case 'get': {
      const { runMemoryGet } = await import('./commands/memory.js');
      await exitAfterFlush(await runMemoryGet(args.slice(1)));
    }

    case 'note': {
      const { runMemoryNote } = await import('./commands/memory.js');
      await exitAfterFlush(await runMemoryNote(args.slice(1)));
    }

    case 'project': {
      const { runProjectCommand } = await import('./commands/project.js');
      await exitAfterFlush(await runProjectCommand(args.slice(1)));
    }

    case 'link': {
      const { runLinkCommand } = await import('./commands/project.js');
      await exitAfterFlush(await runLinkCommand(args.slice(1)));
    }

    case 'projects': {
      const { runProjectsCommand } = await import('./commands/projects.js');
      await exitAfterFlush(await runProjectsCommand(args.slice(1)));
    }

    case 'merge': {
      const { runMergeCommand } = await import('./commands/projects.js');
      await exitAfterFlush(await runMergeCommand(args.slice(1)));
    }

    case 'adopt':
    case 'cleanup': {
      const { runUnavailableCommand } = await import('./commands/runtime.js');
      runUnavailableCommand(command);
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
  void exitAfterFlush(1);
});
