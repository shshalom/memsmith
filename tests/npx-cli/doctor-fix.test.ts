import { describe, expect, it } from 'bun:test';
import {
  applyRepairs,
  parseDoctorArgs,
  planRepairs,
  type DoctorState,
} from '../../src/npx-cli/commands/doctor.js';

const healthy: DoctorState = {
  pidFileStale: false, portInUse: true, depsMissing: false,
  serverReachable: true, serverVersion: '13.10.2', pluginVersion: '13.10.2', remote: false,
};

describe('planRepairs', () => {
  it('plans nothing for a healthy install', () => {
    expect(planRepairs(healthy)).toEqual([]);
  });

  it('removes stale state only when nothing listens on the port', () => {
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: false, serverReachable: false }))
      .toEqual(['remove-stale-state', 'start']);
    expect(planRepairs({ ...healthy, pidFileStale: true, portInUse: true })).not.toContain('remove-stale-state');
  });

  it('restarts a server running an older version', () => {
    expect(planRepairs({ ...healthy, serverVersion: '13.10.1' })).toEqual(['restart']);
  });

  it('installs missing dependencies before starting', () => {
    expect(planRepairs({ ...healthy, depsMissing: true, serverReachable: false, portInUse: false }))
      .toEqual(['install-deps', 'start']);
  });

  it('plans no server repair for a remote server', () => {
    expect(planRepairs({ ...healthy, remote: true, serverReachable: false })).toEqual([]);
  });
});

describe('applyRepairs', () => {
  it('stops at the first failed repair and names it', async () => {
    const ran: string[] = [];
    const result = await applyRepairs(['install-deps', 'start'], {
      removeState: () => ran.push('remove'),
      installDeps: async () => { ran.push('deps'); throw new Error('npm failed'); },
      lifecycle: async (c) => { ran.push(c); return 0; },
      out: () => {},
    });
    expect(result).toEqual({ ok: false, failed: 'install-deps', error: 'npm failed' });
    expect(ran).toEqual(['deps']);
  });

  it('treats a nonzero lifecycle exit as a failure', async () => {
    const result = await applyRepairs(['start'], {
      removeState: () => {}, installDeps: async () => {}, lifecycle: async () => 1, out: () => {},
    });
    expect(result).toMatchObject({ ok: false, failed: 'start' });
  });
});

describe('parseDoctorArgs', () => {
  it('runs read-only checks with no arguments', () => {
    expect(parseDoctorArgs([])).toEqual({ kind: 'run', fix: false });
  });

  it('enables repairs only for --fix', () => {
    expect(parseDoctorArgs(['--fix'])).toEqual({ kind: 'run', fix: true });
  });

  it('prints help without running anything for --help and -h, even next to --fix', () => {
    expect(parseDoctorArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseDoctorArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseDoctorArgs(['--fix', '--help'])).toEqual({ kind: 'help' });
  });

  it('rejects unknown flags instead of ignoring them', () => {
    expect(parseDoctorArgs(['--force'])).toEqual({ kind: 'unknown', flag: '--force' });
    expect(parseDoctorArgs(['--fix', '--force'])).toEqual({ kind: 'unknown', flag: '--force' });
  });
});
