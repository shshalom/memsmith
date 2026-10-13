import { describe, expect, it } from 'bun:test';
import { buildAutoStartCommand } from '../../src/npx-cli/install/autostart.js';

const base = { runtimePath: '/bun', scriptPath: '/p/server-service.cjs', projectCwd: '/home/u' };

describe('install auto-start', () => {
  it('runs server-service start --daemon', () => {
    const { execPath, args } = buildAutoStartCommand({ ...base, useSetsid: false });
    expect({ execPath, args }).toEqual({ execPath: '/bun', args: ['/p/server-service.cjs', 'start', '--daemon'] });
  });

  it('wraps the same command in setsid when available', () => {
    const { execPath, args } = buildAutoStartCommand({ ...base, useSetsid: true });
    expect({ execPath, args }).toEqual({ execPath: '/usr/bin/setsid', args: ['/bun', '/p/server-service.cjs', 'start', '--daemon'] });
  });

  it('pins MEMSMITH_PROJECT_CWD so the daemon does not pick a runtime from the installer cwd', () => {
    for (const useSetsid of [false, true]) {
      expect(buildAutoStartCommand({ ...base, useSetsid }).env).toEqual({ MEMSMITH_PROJECT_CWD: '/home/u' });
    }
  });
});
