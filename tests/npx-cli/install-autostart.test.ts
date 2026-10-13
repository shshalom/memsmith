import { describe, expect, it } from 'bun:test';
import { buildAutoStartCommand } from '../../src/npx-cli/install/autostart.js';

describe('install auto-start', () => {
  it('runs server-service start --daemon', () => {
    expect(buildAutoStartCommand({ runtimePath: '/bun', scriptPath: '/p/server-service.cjs', useSetsid: false }))
      .toEqual({ execPath: '/bun', args: ['/p/server-service.cjs', 'start', '--daemon'] });
  });

  it('wraps the same command in setsid when available', () => {
    expect(buildAutoStartCommand({ runtimePath: '/bun', scriptPath: '/p/server-service.cjs', useSetsid: true }))
      .toEqual({ execPath: '/usr/bin/setsid', args: ['/bun', '/p/server-service.cjs', 'start', '--daemon'] });
  });
});
