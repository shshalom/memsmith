/**
 * `memsmith autostart enable | disable | status` — register or remove the
 * login entry that runs `memsmith start` once when the user logs in.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { resolveWorkerRuntimePath } from '../../services/infrastructure/ProcessManager.js';
import { marketplaceDirectory } from '../utils/paths.js';
import {
  buildLaunchAgentPlist,
  buildSystemdUnit,
  buildWindowsRunValue,
  loginEntryPath,
  type LoginCommand,
  type LoginPlatform,
} from '../autostart/login-entry.js';

export interface AutostartDeps {
  platform: LoginPlatform;
  home: string;
  uid: number;
  resolveCommand(): LoginCommand | null;
  writeFile(path: string, body: string): void;
  removeFile(path: string): void;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
  out(line: string): void;
  err(line: string): void;
}

interface Result {
  ok: boolean;
  message: string;
}

const LABEL = 'com.memsmith.start';
const SERVICE = 'memsmith.service';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'MemSmith';
const USAGE = 'Usage: memsmith autostart enable | disable | status';

function guiTarget(d: AutostartDeps): string {
  return `gui/${d.uid}`;
}

function entryPathOf(d: AutostartDeps): string {
  const path = loginEntryPath(d.platform, d.home);
  if (!path) throw new Error(`No login entry file on ${d.platform}`);
  return path;
}

export function enableLoginAutostart(d: AutostartDeps): Result {
  const cmd = d.resolveCommand();
  if (!cmd) {
    return {
      ok: false,
      message: 'Cannot register start at login: Bun or the MemSmith server script was not found. Run `npx memsmith install` first.',
    };
  }

  switch (d.platform) {
    case 'darwin': {
      const plist = entryPathOf(d);
      d.run('launchctl', ['bootout', `${guiTarget(d)}/${LABEL}`]);
      d.writeFile(plist, buildLaunchAgentPlist(cmd));
      const r = d.run('launchctl', ['bootstrap', guiTarget(d), plist]);
      if (r.code !== 0) {
        return { ok: false, message: `launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      return { ok: true, message: 'MemSmith starts when you log in.' };
    }
    case 'linux': {
      const probe = d.run('systemctl', ['--user', 'show-environment']);
      if (probe.code !== 0) {
        return {
          ok: false,
          message: 'No systemd user instance is available. Add `memsmith start` to your shell profile to start MemSmith at login.',
        };
      }
      d.writeFile(entryPathOf(d), buildSystemdUnit(cmd));
      d.run('systemctl', ['--user', 'daemon-reload']);
      const r = d.run('systemctl', ['--user', 'enable', SERVICE]);
      if (r.code !== 0) {
        return { ok: false, message: `systemctl enable failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      return { ok: true, message: 'MemSmith starts when you log in.' };
    }
    case 'win32': {
      const r = d.run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', buildWindowsRunValue(cmd), '/f']);
      if (r.code !== 0) {
        return { ok: false, message: `reg add failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      return { ok: true, message: 'MemSmith starts when you log in.' };
    }
  }
}

export function disableLoginAutostart(d: AutostartDeps): Result {
  const done: Result = { ok: true, message: 'MemSmith no longer starts when you log in.' };
  switch (d.platform) {
    case 'darwin': {
      d.run('launchctl', ['bootout', `${guiTarget(d)}/${LABEL}`]);
      d.removeFile(entryPathOf(d));
      return done;
    }
    case 'linux': {
      d.run('systemctl', ['--user', 'disable', SERVICE]);
      d.removeFile(entryPathOf(d));
      d.run('systemctl', ['--user', 'daemon-reload']);
      return done;
    }
    case 'win32': {
      const r = d.run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
      if (r.code !== 0 && !/unable to find/i.test(`${r.stdout}${r.stderr}`)) {
        return { ok: false, message: `reg delete failed: ${r.stderr.trim() || `exit ${r.code}`}` };
      }
      return done;
    }
  }
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function scriptFromPlist(body: string): string | null {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)?.[1];
  if (!args) return null;
  const strings = [...args.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]));
  return strings[1] ?? null;
}

function splitSystemdWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(c) && !quoted) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) words.push(current);
  return words.map((w) => w.replace(/%%/g, '%').replace(/\$\$/g, '$'));
}

function scriptFromUnit(body: string): string | null {
  const line = /^ExecStart=(.*)$/m.exec(body)?.[1];
  return line ? (splitSystemdWords(line)[1] ?? null) : null;
}

function scriptFromRunValue(data: string): string | null {
  const quoted = [...data.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return quoted[1] ?? null;
}

export function loginAutostartStatus(d: AutostartDeps): { registered: boolean; healthy: boolean; command?: string } {
  let command: string | null = null;
  let script: string | null = null;

  if (d.platform === 'win32') {
    const r = d.run('reg', ['query', RUN_KEY, '/v', RUN_VALUE]);
    if (r.code !== 0) return { registered: false, healthy: false };
    command = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout)?.[1] ?? null;
    script = command ? scriptFromRunValue(command) : null;
  } else {
    const body = d.readFile(entryPathOf(d));
    if (body === null) return { registered: false, healthy: false };
    script = d.platform === 'darwin' ? scriptFromPlist(body) : scriptFromUnit(body);
    command = script;
  }

  return {
    registered: true,
    healthy: script !== null && d.exists(script),
    ...(command ? { command } : {}),
  };
}

export async function runAutostartCommand(argv: string[], d: AutostartDeps = defaultAutostartDeps()): Promise<number> {
  switch (argv[0]) {
    case 'enable':
    case 'disable': {
      const r = argv[0] === 'enable' ? enableLoginAutostart(d) : disableLoginAutostart(d);
      (r.ok ? d.out : d.err)(r.message);
      return r.ok ? 0 : 1;
    }
    case 'status': {
      const s = loginAutostartStatus(d);
      if (!s.registered) {
        d.out('MemSmith does not start when you log in. Run `memsmith autostart enable` to turn it on.');
        return 0;
      }
      if (!s.healthy) {
        d.err(`The login entry points to a missing script${s.command ? `: ${s.command}` : ''}. Run \`memsmith autostart enable\` to repair it.`);
        return 1;
      }
      d.out(`MemSmith starts when you log in${s.command ? `: ${s.command}` : ''}.`);
      return 0;
    }
    default:
      d.err(USAGE);
      return 1;
  }
}

export function defaultAutostartDeps(): AutostartDeps {
  return {
    platform: process.platform as LoginPlatform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    resolveCommand() {
      const bunPath = resolveWorkerRuntimePath();
      const scriptPath = join(marketplaceDirectory(), 'plugin', 'scripts', 'server-service.cjs');
      if (!bunPath || !existsSync(scriptPath)) return null;
      const dataDir = process.env.MEMSMITH_DATA_DIR || join(homedir(), '.memsmith');
      return { bunPath, scriptPath, logPath: join(dataDir, 'logs', 'launchd-start.log') };
    },
    writeFile(path, body) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    },
    removeFile: (path) => rmSync(path, { force: true }),
    exists: (path) => existsSync(path),
    readFile(path) {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return null;
      }
    },
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: 'utf-8' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}
