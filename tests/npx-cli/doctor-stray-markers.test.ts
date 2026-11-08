import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyRepairs,
  collectChecks,
  planRepairs,
  scanStrayMarkers,
  strayMarkerCheck,
  type DoctorProbes,
} from '../../src/npx-cli/commands/doctor.js';

function marker(dir: string, projectId: string) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n' }));
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ms-doctor-stray-')));
  mkdirSync(join(root, '.git'));
  marker(root, 'p-root');
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  marker(join(root, 'packages', 'cli'), 'p-cli');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('strayMarkerCheck', () => {
  it('passes when no nested marker names another project', () => {
    expect(strayMarkerCheck([])).toMatchObject({ name: 'Stray markers', status: 'ok', required: false });
  });

  it('reports each stray with its records and the commands that fold it in', () => {
    const check = strayMarkerCheck([{ dir: join(root, 'packages', 'cli'), root, rootProjectId: 'p-root', projectId: 'p-cli', records: 12 }]);
    expect(check.status).toBe('warn');
    expect(check.required).toBe(false);
    const notes = check.notes!.join('\n');
    expect(notes).toContain(join(root, 'packages', 'cli'));
    expect(notes).toContain('12 records');
    expect(notes).toContain('memsmith merge p-cli p-root');
    expect(notes).toContain(`memsmith link (run in ${join(root, 'packages', 'cli')})`);
    expect(notes).toContain('own repository');
  });
});

describe('scanStrayMarkers', () => {
  it('scans the given roots and attaches record counts it knows', () => {
    const strays = scanStrayMarkers([root], new Map([['p-cli', 4]]));
    expect(strays).toEqual([{ dir: join(root, 'packages', 'cli'), root, rootProjectId: 'p-root', projectId: 'p-cli', records: 4 }]);
  });
});

describe('doctor --fix and stray markers', () => {
  it('reports a stray but never rewrites it', async () => {
    const path = join(root, 'packages', 'cli', '.memsmith', 'project.json');
    const before = readFileSync(path, 'utf-8');
    const probes: DoctorProbes = {
      probeVersion: () => '1.0.0',
      isPluginInstalled: () => true,
      marketplaceDirectory: () => root,
      installedPluginVersion: () => '13.15.0',
      probeServerHealth: async () => ({ reachable: true, version: '13.15.0' }),
      readServerPidFile: () => null,
      verifyPidFileOwnership: () => true,
      isPortInUse: async () => true,
      dataDir: () => root,
      generation: async () => ({ provider: 'claude', missingCredential: null }),
      strayMarkers: async () => scanStrayMarkers([root], new Map()),
    };
    const { checks, state } = await collectChecks(true, false, { env: {} }, probes);
    expect(checks.find((c) => c.name === 'Stray markers')?.status).toBe('warn');
    const ran: string[] = [];
    await applyRepairs(planRepairs(state), {
      removeState: () => ran.push('remove'), installDeps: async () => { ran.push('deps'); },
      lifecycle: async (c) => { ran.push(c); return 0; }, ollama: async () => true, out: () => {},
    });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});
