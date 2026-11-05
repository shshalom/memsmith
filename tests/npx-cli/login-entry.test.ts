import { describe, expect, it } from 'bun:test';
import {
  buildLaunchAgentPlist,
  buildSystemdUnit,
  buildWindowsRunValue,
  loginEntryPath,
  type LoginCommand,
} from '../../src/npx-cli/autostart/login-entry.js';

const posixCmd: LoginCommand = {
  bunPath: '/Users/ana/.bun/bin/bun',
  scriptPath: '/Users/ana/.claude/plugins/marketplaces/shshalom/plugin/scripts/server-service.cjs',
  logPath: '/Users/ana/.memsmith/logs/login.log',
};

describe('buildLaunchAgentPlist', () => {
  it('runs bun with the script and start as separate arguments, RunAtLoad true, no KeepAlive, label com.memsmith.start', () => {
    const plist = buildLaunchAgentPlist(posixCmd);
    expect(plist).toContain('<key>Label</key>\n  <string>com.memsmith.start</string>');
    expect(plist).toContain(
      '<array>\n    <string>/Users/ana/.bun/bin/bun</string>\n    <string>' +
        posixCmd.scriptPath +
        '</string>\n    <string>start</string>\n  </array>',
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).not.toContain('KeepAlive');
    expect(plist).toContain('<key>StandardOutPath</key>\n  <string>/Users/ana/.memsmith/logs/login.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/ana/.memsmith/logs/login.log</string>');
  });

  it('puts the Bun directory first on PATH', () => {
    const plist = buildLaunchAgentPlist(posixCmd);
    expect(plist).toContain(
      '<string>/Users/ana/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
  });

  it('escapes XML special characters in paths', () => {
    const plist = buildLaunchAgentPlist({
      ...posixCmd,
      bunPath: '/Users/a&b/<bun>/bun',
      logPath: '/tmp/"x"/log',
    });
    expect(plist).toContain('<string>/Users/a&amp;b/&lt;bun&gt;/bun</string>');
    expect(plist).toContain('/tmp/&quot;x&quot;/log');
    expect(plist).not.toContain('a&b');
  });
});

describe('buildSystemdUnit', () => {
  it('is oneshot with RemainAfterExit and WantedBy=default.target, and quotes a path with spaces', () => {
    const unit = buildSystemdUnit({
      bunPath: '/home/ana silva/.bun/bin/bun',
      scriptPath: '/home/ana silva/.claude/server-service.cjs',
      logPath: '/home/ana silva/.memsmith/logs/login.log',
    });
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(
      'ExecStart="/home/ana silva/.bun/bin/bun" "/home/ana silva/.claude/server-service.cjs" start',
    );
    expect(unit).toContain(
      'Environment="PATH=/home/ana silva/.bun/bin:/usr/local/bin:/usr/bin:/bin"',
    );
  });

  it('leaves paths without special characters unquoted', () => {
    const unit = buildSystemdUnit(posixCmd);
    expect(unit).toContain(`ExecStart=/Users/ana/.bun/bin/bun ${posixCmd.scriptPath} start`);
  });

  it('escapes quotes, backslashes, and percent signs in ExecStart', () => {
    const unit = buildSystemdUnit({ ...posixCmd, scriptPath: '/opt/a"b\\c%d/s.cjs' });
    expect(unit).toContain('"/opt/a\\"b\\\\c%%d/s.cjs"');
  });
});

describe('buildWindowsRunValue', () => {
  it('quotes both paths', () => {
    const value = buildWindowsRunValue({
      bunPath: 'C:\\Users\\Ana Silva\\.bun\\bin\\bun.exe',
      scriptPath: 'C:\\Users\\Ana Silva\\.claude\\server-service.cjs',
      logPath: 'C:\\Users\\Ana Silva\\.memsmith\\logs\\login.log',
    });
    expect(value).toBe(
      '"C:\\Users\\Ana Silva\\.bun\\bin\\bun.exe" "C:\\Users\\Ana Silva\\.claude\\server-service.cjs" start',
    );
  });
});

describe('loginEntryPath', () => {
  it('returns the LaunchAgents plist on darwin, the systemd user unit on linux, null on win32', () => {
    expect(loginEntryPath('darwin', '/Users/ana')).toBe('/Users/ana/Library/LaunchAgents/com.memsmith.start.plist');
    expect(loginEntryPath('linux', '/home/ana')).toBe('/home/ana/.config/systemd/user/memsmith.service');
    expect(loginEntryPath('win32', 'C:\\Users\\ana')).toBeNull();
  });
});
