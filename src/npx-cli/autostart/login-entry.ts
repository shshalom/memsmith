import { posix } from 'path';

export type LoginPlatform = 'darwin' | 'linux' | 'win32';

export interface LoginCommand {
  bunPath: string;
  scriptPath: string;
  logPath: string;
}

const LAUNCH_AGENT_LABEL = 'com.memsmith.start';
const DARWIN_BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_BASE_PATH = '/usr/local/bin:/usr/bin:/bin';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildLaunchAgentPlist(cmd: LoginCommand): string {
  const path = `${posix.dirname(cmd.bunPath)}:${DARWIN_BASE_PATH}`;
  const log = escapeXml(cmd.logPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cmd.bunPath)}</string>
    <string>${escapeXml(cmd.scriptPath)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\%$]/.test(value) ? `"${escaped}"` : escaped;
}

export function buildSystemdUnit(cmd: LoginCommand): string {
  const path = `${posix.dirname(cmd.bunPath)}:${LINUX_BASE_PATH}`;
  return `[Unit]
Description=Start MemSmith at login

[Service]
Type=oneshot
RemainAfterExit=yes
Environment="PATH=${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"
ExecStart=${systemdQuote(cmd.bunPath)} ${systemdQuote(cmd.scriptPath)} start

[Install]
WantedBy=default.target
`;
}

export function buildWindowsRunValue(cmd: LoginCommand): string {
  return `"${cmd.bunPath}" "${cmd.scriptPath}" start`;
}

export function loginEntryPath(platform: LoginPlatform, home: string): string | null {
  switch (platform) {
    case 'darwin':
      return posix.join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
    case 'linux':
      return posix.join(home, '.config', 'systemd', 'user', 'memsmith.service');
    case 'win32':
      return null;
  }
}
