import { describe, expect, it } from 'bun:test';
import {
  disableLoginAutostart,
  enableLoginAutostart,
  loginAutostartStatus,
  runAutostartCommand,
  type AutostartDeps,
} from '../../src/npx-cli/commands/autostart.js';
import type { LoginPlatform } from '../../src/npx-cli/autostart/login-entry.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

interface Fake {
  deps: AutostartDeps;
  files: Map<string, string>;
  calls: string[];
  outLines: string[];
  errLines: string[];
}

function fake(
  platform: LoginPlatform,
  opts: {
    command?: AutostartDeps['resolveCommand'];
    run?: (line: string) => { code: number; stdout?: string; stderr?: string } | undefined;
  } = {},
): Fake {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const outLines: string[] = [];
  const errLines: string[] = [];
  const deps: AutostartDeps = {
    platform,
    home: '/home/u',
    uid: 501,
    resolveCommand: opts.command ?? (() => ({
      bunPath: '/opt/bun/bin/bun',
      scriptPath: '/mkt/plugin/scripts/server-service.cjs',
      logPath: '/home/u/.memsmith/logs/launchd-start.log',
    })),
    writeFile: (p, b) => void files.set(p, b),
    removeFile: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    run: (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      const r = opts.run?.(line);
      return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    out: (l) => void outLines.push(l),
    err: (l) => void errLines.push(l),
  };
  return { deps, files, calls, outLines, errLines };
}

const PLIST = '/home/u/Library/LaunchAgents/com.memsmith.start.plist';
const UNIT = '/home/u/.config/systemd/user/memsmith.service';

describe('enableLoginAutostart', () => {
  it('on darwin boots out, writes the plist, then bootstraps gui/<uid>', () => {
    const f = fake('darwin');
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual([
      'launchctl bootout gui/501/com.memsmith.start',
      `launchctl bootstrap gui/501 ${PLIST}`,
    ]);
    expect(f.files.get(PLIST)).toContain('<string>/mkt/plugin/scripts/server-service.cjs</string>');
  });

  it('on darwin succeeds twice and leaves one plist', () => {
    const f = fake('darwin');
    expect(enableLoginAutostart(f.deps).ok).toBe(true);
    expect(enableLoginAutostart(f.deps).ok).toBe(true);
    expect([...f.files.keys()]).toEqual([PLIST]);
  });

  it('on darwin reports bootstrap stderr when bootstrap fails', () => {
    const f = fake('darwin', {
      run: (l) => (l.startsWith('launchctl bootstrap') ? { code: 5, stderr: 'Bootstrap failed: 5' } : undefined),
    });
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Bootstrap failed: 5');
  });

  it('on linux checks the user instance, writes the unit, then reloads and enables', () => {
    const f = fake('linux');
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      'systemctl --user enable memsmith.service',
    ]);
    expect(f.files.get(UNIT)).toContain('ExecStart=/opt/bun/bin/bun /mkt/plugin/scripts/server-service.cjs start');
  });

  it('on linux without a systemd user instance fails and writes no unit', () => {
    const f = fake('linux', { run: () => ({ code: 1, stderr: 'Failed to connect to bus' }) });
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('memsmith start');
    expect(f.files.size).toBe(0);
  });

  it('on win32 adds the Run value with the quoted command', () => {
    const f = fake('win32');
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(true);
    expect(f.calls).toEqual([
      `reg add ${RUN_KEY} /v MemSmith /t REG_SZ /d "/opt/bun/bin/bun" "/mkt/plugin/scripts/server-service.cjs" start /f`,
    ]);
  });

  it('fails clearly when Bun or the script cannot be resolved', () => {
    const f = fake('darwin', { command: () => null });
    const r = enableLoginAutostart(f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Bun');
    expect(f.calls).toEqual([]);
    expect(f.files.size).toBe(0);
  });
});

describe('disableLoginAutostart', () => {
  it('on darwin boots out and deletes the plist', () => {
    const f = fake('darwin');
    enableLoginAutostart(f.deps);
    f.calls.length = 0;
    expect(disableLoginAutostart(f.deps).ok).toBe(true);
    expect(f.calls).toEqual(['launchctl bootout gui/501/com.memsmith.start']);
    expect(f.files.size).toBe(0);
  });

  it('succeeds when nothing is registered, even if bootout fails', () => {
    const f = fake('darwin', { run: () => ({ code: 3 }) });
    expect(disableLoginAutostart(f.deps).ok).toBe(true);
  });

  it('on linux disables, deletes the unit, and reloads', () => {
    const f = fake('linux');
    enableLoginAutostart(f.deps);
    f.calls.length = 0;
    expect(disableLoginAutostart(f.deps).ok).toBe(true);
    expect(f.calls).toEqual([
      'systemctl --user disable memsmith.service',
      'systemctl --user daemon-reload',
    ]);
    expect(f.files.size).toBe(0);
  });

  it('on win32 deletes the Run value', () => {
    const f = fake('win32');
    expect(disableLoginAutostart(f.deps).ok).toBe(true);
    expect(f.calls).toEqual([`reg delete ${RUN_KEY} /v MemSmith /f`]);
  });

  it('on win32 treats a missing value as success', () => {
    const f = fake('win32', {
      run: () => ({ code: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' }),
    });
    expect(disableLoginAutostart(f.deps).ok).toBe(true);
  });

  it('on win32 fails on any other reg error', () => {
    const f = fake('win32', { run: () => ({ code: 1, stderr: 'ERROR: Access is denied.' }) });
    expect(disableLoginAutostart(f.deps).ok).toBe(false);
  });
});

describe('loginAutostartStatus', () => {
  it('is unregistered when no entry exists', () => {
    const f = fake('darwin');
    expect(loginAutostartStatus(f.deps)).toEqual({ registered: false, healthy: false });
  });

  it('is healthy on darwin when the registered script exists', () => {
    const f = fake('darwin');
    enableLoginAutostart(f.deps);
    f.files.set('/mkt/plugin/scripts/server-service.cjs', '');
    const s = loginAutostartStatus(f.deps);
    expect(s.registered).toBe(true);
    expect(s.healthy).toBe(true);
    expect(s.command).toContain('server-service.cjs');
  });

  it('is broken when the registered script no longer exists', () => {
    const f = fake('darwin');
    enableLoginAutostart(f.deps);
    expect(loginAutostartStatus(f.deps)).toMatchObject({ registered: true, healthy: false });
  });

  it('recovers a script path containing spaces and percent signs on linux', () => {
    const f = fake('linux', {
      command: () => ({ bunPath: '/b/bun', scriptPath: '/my dir/100%/server-service.cjs', logPath: '/l' }),
    });
    enableLoginAutostart(f.deps);
    f.files.set('/my dir/100%/server-service.cjs', '');
    expect(loginAutostartStatus(f.deps)).toMatchObject({ registered: true, healthy: true });
  });

  it('on win32 reads the value back with reg query and checks the script', () => {
    const query = (script: string) => ({
      code: 0,
      stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    MemSmith    REG_SZ    "C:\\bun\\bun.exe" "${script}" start\r\n\r\n`,
    });
    const f = fake('win32', { run: () => query('C:\\mkt\\server-service.cjs') });
    expect(loginAutostartStatus(f.deps)).toMatchObject({ registered: true, healthy: false });
    expect(f.calls[0]).toBe(`reg query ${RUN_KEY} /v MemSmith`);
    f.files.set('C:\\mkt\\server-service.cjs', '');
    expect(loginAutostartStatus(f.deps)).toMatchObject({ registered: true, healthy: true });
  });

  it('on win32 is unregistered when reg query fails', () => {
    const f = fake('win32', { run: () => ({ code: 1 }) });
    expect(loginAutostartStatus(f.deps)).toEqual({ registered: false, healthy: false });
  });
});

describe('runAutostartCommand', () => {
  it('prints usage and returns 1 for an unknown action', async () => {
    const f = fake('darwin');
    expect(await runAutostartCommand(['bogus'], f.deps)).toBe(1);
    expect(f.errLines.join('\n')).toContain('autostart enable | disable | status');
  });

  it('returns 0 on enable and 1 when enable fails', async () => {
    expect(await runAutostartCommand(['enable'], fake('darwin').deps)).toBe(0);
    expect(await runAutostartCommand(['enable'], fake('darwin', { command: () => null }).deps)).toBe(1);
  });

  it('status returns 0 when healthy and 1 when registered but broken', async () => {
    const f = fake('darwin');
    await runAutostartCommand(['enable'], f.deps);
    expect(await runAutostartCommand(['status'], f.deps)).toBe(1);
    f.files.set('/mkt/plugin/scripts/server-service.cjs', '');
    expect(await runAutostartCommand(['status'], f.deps)).toBe(0);
  });
});
