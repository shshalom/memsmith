/**
 * `npx memsmith telemetry [status|enable|disable]` — manage anonymous usage
 * analytics. Nothing is sent unless a PostHog key is configured with
 * MEMSMITH_TELEMETRY_KEY. With a key, telemetry is opt-out: turn it off with
 * `telemetry disable`, MEMSMITH_TELEMETRY=0, or DO_NOT_TRACK=1.
 */

import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { getTelemetryApiKey } from '../../services/telemetry/common.js';
import {
  explainTelemetryConsent,
  loadTelemetryConfig,
  saveTelemetryConfig,
  getOrCreateInstallId,
  getTelemetryConfigPath,
  type TelemetryConsentSource,
} from '../../services/telemetry/consent.js';

const DOCS_URL = 'https://github.com/shshalom/memsmith/blob/main/docs/public/telemetry.mdx';

const COLLECTED_FIELDS = [
  'version          memsmith version (e.g. 13.10.2)',
  'os               platform (darwin / linux / win32)',
  'os_version       OS kernel release (e.g. 10.0.22631)',
  'is_wsl           whether running under WSL',
  'arch             CPU architecture (arm64 / x64)',
  'runtime          bun or node',
  'runtime_version  runtime version string',
  'node_version     Node.js version string',
  'is_ci            whether running in CI',
  'locale           language tag (e.g. en-US)',
  'ide              installer IDE choice (claude-code / cursor / ...)',
  'provider         generation provider (claude / gemini / openrouter / ollama)',
  'runtime_mode     local or server',
  'is_update        whether an install was an update',
  'outcome          ok / partial',
  'duration_ms      how long the install took',
  'interactive      whether the installer ran in a TTY',
  'install_method   npm / bun / pnpm / yarn / unknown',
  'bun_version / uv_version / claude_code_version',
  '                 toolchain versions detected during install',
  'error_category   install error category id (never a message)',
  'hook_type        context / session-init / observation / summarize / file-context',
  'error_mode       worker_unavailable / blocking_error (never a message)',
  'consecutive_failures   hook failures in a row',
  'threshold_tripped      whether the failure threshold was reached',
];

const EVENT_NAMES = [
  'install_completed',
  'install_failed',
  'uninstall_completed',
  'hook_failed',
];

const SOURCE_LABELS: Record<TelemetryConsentSource, string> = {
  DO_NOT_TRACK: 'DO_NOT_TRACK environment variable',
  env: 'MEMSMITH_TELEMETRY environment variable',
  config: 'telemetry.json config file',
  default: 'default (on — no opt-out recorded)',
};

function printTelemetryUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx memsmith telemetry [status|enable|disable]')}`);
  console.error('  status   Show whether telemetry is on and which setting decided it (default)');
  console.error('  enable   Turn anonymous usage analytics back on (interactive)');
  console.error('  disable  Opt out of telemetry');
  console.error(`Docs: ${DOCS_URL}`);
}

function runTelemetryStatus(): void {
  // Status is read-only: it must never create telemetry.json as a side effect.
  const config = loadTelemetryConfig();
  if (getTelemetryApiKey() === null) {
    console.log(`${styleText('bold', 'Telemetry:')} disabled (no telemetry key configured)`);
    console.log(`${styleText('bold', 'Docs:')} ${DOCS_URL}`);
    return;
  }
  const { enabled, source } = explainTelemetryConsent(process.env, config);

  const state = enabled ? styleText('green', 'ENABLED') : styleText('yellow', 'DISABLED');
  console.log(`${styleText('bold', 'Telemetry:')} ${state}`);
  console.log(`${styleText('bold', 'Decided by:')} ${SOURCE_LABELS[source]}`);
  if (config?.installId) {
    console.log(`${styleText('bold', 'Install ID:')} ${config.installId} ${styleText('dim', '(random UUID, not tied to you)')}`);
  } else if (config) {
    console.log(`${styleText('bold', 'Install ID:')} ${styleText('dim', 'none recorded')}`);
  } else {
    console.log(`${styleText('bold', 'Install ID:')} ${styleText('dim', 'none (no telemetry config has been written)')}`);
  }
  console.log(`${styleText('bold', 'Config file:')} ${getTelemetryConfigPath()}`);
  console.log(`${styleText('bold', 'Docs:')} ${DOCS_URL}`);
}

async function runTelemetryEnable(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error(styleText('red', 'telemetry enable requires an interactive terminal (consent prompt).'));
    console.error(`Read what is collected first: ${DOCS_URL}`);
    process.exit(1);
  }

  p.intro(styleText(['bgBlue', 'white'], ' memsmith telemetry '));

  p.note(
    [
      'Anonymous events only, identified by a random install UUID:',
      ...EVENT_NAMES.map((name) => `  ${name}`),
      '',
      'Each event carries ONLY these fields:',
      ...COLLECTED_FIELDS.map((line) => `  ${line}`),
      '',
      'PostHog can derive coarse location (country / region / city) from the',
      'request IP at ingest. MemSmith never attaches the IP to an event.',
      '',
      'NEVER collected — not now, not ever:',
      '  prompts or conversation content, file paths, source code,',
      '  project names, git remotes, search queries, error messages,',
      '  IP addresses, hardware IDs, env values, emails.',
      '',
      `Full details: ${DOCS_URL}`,
    ].join('\n'),
    'What telemetry collects'
  );

  if (process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== '0' && process.env.DO_NOT_TRACK !== 'false') {
    p.log.warn(
      'DO_NOT_TRACK is set in your environment. It overrides everything: telemetry will remain OFF even after enabling here.'
    );
  }

  const shouldEnable = await p.confirm({
    message: 'Enable anonymous usage telemetry?',
    initialValue: true,
  });

  if (p.isCancel(shouldEnable) || !shouldEnable) {
    p.cancel('Telemetry remains disabled. Nothing was written.');
    return;
  }

  // getOrCreateInstallId() persists a config if none exists; reuse its ID.
  const installId = getOrCreateInstallId();
  saveTelemetryConfig({
    enabled: true,
    installId,
    decidedAt: new Date().toISOString(),
  });

  p.log.success(`Telemetry enabled. Config: ${getTelemetryConfigPath()}`);
  p.outro(`Change your mind anytime: ${styleText('cyan', 'npx memsmith telemetry disable')}`);
}

function runTelemetryDisable(): void {
  const existing = loadTelemetryConfig();
  saveTelemetryConfig({
    enabled: false,
    installId: existing?.installId ?? '',
    decidedAt: new Date().toISOString(),
  });

  console.log(styleText('green', 'Telemetry disabled.'));
  console.log(`${styleText('bold', 'Config file:')} ${getTelemetryConfigPath()}`);
}

export async function runTelemetryCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase() ?? 'status';

  switch (subCommand) {
    case 'status':
      runTelemetryStatus();
      break;
    case 'enable':
      await runTelemetryEnable();
      break;
    case 'disable':
      runTelemetryDisable();
      break;
    default:
      console.error(styleText('red', `Unknown telemetry subcommand: ${subCommand}`));
      printTelemetryUsage();
      process.exit(1);
  }
}
