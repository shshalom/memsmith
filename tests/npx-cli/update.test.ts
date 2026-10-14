import { describe, it, expect } from 'bun:test';
import {
  runUpdate,
  isNewerVersion,
  syncInstalledPluginEntries,
  type UpdateDeps,
  type ServerState,
} from '../../src/npx-cli/commands/update.js';

interface FakeOpts {
  cli?: string;
  latest?: string | null;
  reexec?: boolean;
  installed?: string | null;
  cacheReady?: boolean;
  server?: ServerState;
  versionAfterStart?: string;
  stopCode?: number;
  startCode?: number;
  registryChanged?: number;
  installThrows?: Error;
  reexecCode?: number;
  stoppedMarker?: boolean;
}

function fake(opts: FakeOpts = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let server: ServerState = opts.server ?? { kind: 'running', version: opts.installed ?? '1.0.0' };
  let marker = opts.stoppedMarker ?? false;
  const deps: UpdateDeps = {
    cliVersion: () => opts.cli ?? '1.1.0',
    latestPublished: async () => { calls.push('latest'); return opts.latest === undefined ? opts.cli ?? '1.1.0' : opts.latest; },
    isReexec: () => opts.reexec ?? false,
    reexecLatest: async (version, argv) => { calls.push(`reexec:${version}:${argv.join(' ')}`); return opts.reexecCode ?? 0; },
    isInstalled: () => opts.installed !== null,
    installedVersion: () => (opts.installed === undefined ? '1.0.0' : opts.installed),
    cacheReady: () => opts.cacheReady ?? true,
    installPluginFiles: async (version) => { calls.push(`install:${version}`); if (opts.installThrows) throw opts.installThrows; },
    syncRegistry: (version) => { calls.push(`registry:${version}`); return { changed: opts.registryChanged ?? 1, skipped: [] }; },
    serverStoppedByUpdate: () => marker,
    setServerStoppedByUpdate: (stopped) => { marker = stopped; calls.push(`marker:${stopped}`); },
    serverState: async () => server,
    stopServer: async () => {
      calls.push('stop');
      if ((opts.stopCode ?? 0) === 0) server = { kind: 'stopped' };
      return opts.stopCode ?? 0;
    },
    startServer: async () => {
      calls.push('start');
      if ((opts.startCode ?? 0) === 0) server = { kind: 'running', version: opts.versionAfterStart ?? opts.cli ?? '1.1.0' };
      return opts.startCode ?? 0;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, out, err, text: () => [...out, ...err].join('\n'), marker: () => marker };
}

describe('memsmith update', () => {
  it('re-runs the newest published CLI when this one is older', async () => {
    const f = fake({ cli: '1.1.0', latest: '1.2.0' });
    expect(await runUpdate(['--force'], f.deps)).toBe(0);
    expect(f.calls).toEqual(['latest', 'reexec:1.2.0:--force']);
  });

  it('does not re-run itself again inside the re-run', async () => {
    const f = fake({ cli: '1.1.0', latest: '1.2.0', reexec: true, installed: '1.0.0' });
    await runUpdate([], f.deps);
    expect(f.calls).not.toContain('latest');
    expect(f.calls.some(c => c.startsWith('reexec'))).toBe(false);
    expect(f.calls).toContain('install:1.1.0');
  });

  it('continues with its own version when npm cannot be reached', async () => {
    const f = fake({ cli: '1.1.0', latest: null, installed: '1.0.0' });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).toContain('install:1.1.0');
    expect(f.text()).toContain("Couldn't check npm");
  });

  it('stops the old server before replacing files, then starts the new one', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.0.0', server: { kind: 'running', version: '1.0.0' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).toEqual(['latest', 'stop', 'marker:true', 'install:1.1.0', 'registry:1.1.0', 'start', 'marker:false']);
    expect(f.text()).toContain('Server: 1.1.0');
  });

  it('only restarts the server when the plugin is current but the server is not', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.1.0', server: { kind: 'running', version: '1.0.0' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).toEqual(['latest', 'registry:1.1.0', 'stop', 'marker:true', 'start', 'marker:false']);
  });

  it('changes nothing on disk or in the server when everything is current', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.1.0', registryChanged: 0, server: { kind: 'running', version: '1.1.0' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).toEqual(['latest', 'registry:1.1.0', 'marker:false']);
    expect(f.text()).toContain('already up to date');
    expect(f.text()).not.toContain('Restart Claude Code');
  });

  it('reinstalls the files when the cache folder is incomplete', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.1.0', cacheReady: false, server: { kind: 'stopped' } });
    await runUpdate([], f.deps);
    expect(f.calls).toContain('install:1.1.0');
  });

  it('leaves a stopped server stopped and says how to start it', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.0.0', server: { kind: 'stopped' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).not.toContain('start');
    expect(f.text()).toContain('memsmith start');
  });

  it('does not touch a remote team server', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.0.0', server: { kind: 'remote', baseUrl: 'https://team.example' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).not.toContain('stop');
    expect(f.calls).not.toContain('start');
  });

  it('refuses to downgrade a newer installed plugin unless forced', async () => {
    const f = fake({ cli: '1.1.0', latest: '1.1.0', installed: '1.2.0' });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.calls).toEqual(['latest']);
    expect(f.text()).toContain('--force');

    const forced = fake({ cli: '1.1.0', latest: '1.1.0', installed: '1.2.0', server: { kind: 'stopped' } });
    expect(await runUpdate(['--force'], forced.deps)).toBe(0);
    expect(forced.calls).toContain('install:1.1.0');
  });

  it('fails without replacing files when the old server will not stop', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.0.0', stopCode: 1 });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.calls).not.toContain('install:1.1.0');
  });

  it('fails when the restarted server still reports another version', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.0.0', versionAfterStart: '1.0.0' });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.text()).toContain('still reports 1.0.0');
  });

  it('says the server is stopped and how to recover when installing fails', async () => {
    const failure = Object.assign(new Error('npm install failed (exit 1)'), { remediation: 'Check your network, then retry.' });
    const f = fake({ cli: '1.1.0', installed: '1.0.0', installThrows: failure });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.calls).not.toContain('start');
    expect(f.marker()).toBe(true);
    expect(f.text()).toContain('npm install failed (exit 1)');
    expect(f.text()).toContain('Check your network, then retry.');
    expect(f.text()).toContain('The server is stopped');
    expect(f.text()).toContain('memsmith update --force');
  });

  it('finishes the install and starts the server after an earlier failed run', async () => {
    const f = fake({ cli: '1.1.0', installed: '1.1.0', stoppedMarker: true, server: { kind: 'stopped' } });
    expect(await runUpdate([], f.deps)).toBe(0);
    expect(f.calls).toContain('install:1.1.0');
    expect(f.calls).toContain('start');
    expect(f.marker()).toBe(false);
    expect(f.text()).toContain('Server: 1.1.0');
  });

  it('explains how to finish when npx cannot run the newer CLI', async () => {
    const f = fake({ cli: '1.1.0', latest: '1.2.0', reexecCode: 127 });
    expect(await runUpdate([], f.deps)).toBe(127);
    expect(f.text()).toContain('npm install -g memsmith@1.2.0');
    expect(f.text()).toContain('--no-self-update');
  });

  it('points at the newer CLI\'s own error when it ran and failed', async () => {
    const f = fake({ cli: '1.1.0', latest: '1.2.0', reexecCode: 1 });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.text()).toContain('see the error above');
    expect(f.text()).not.toContain('npm install -g');
  });

  it('asks for an install when MemSmith is not installed', async () => {
    const f = fake({ installed: null });
    expect(await runUpdate([], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.text()).toContain('memsmith install');
  });

  it('prints usage for --help and rejects unknown options without acting', async () => {
    const help = fake();
    expect(await runUpdate(['--help'], help.deps)).toBe(0);
    expect(help.calls).toEqual([]);
    expect(help.text()).toContain('Usage: memsmith update');

    const bad = fake();
    expect(await runUpdate(['--frobnicate'], bad.deps)).toBe(1);
    expect(bad.calls).toEqual([]);
  });

  it('skips the npm check with --no-self-update', async () => {
    const f = fake({ cli: '1.1.0', latest: '9.9.9', installed: '1.0.0' });
    await runUpdate(['--no-self-update'], f.deps);
    expect(f.calls).not.toContain('latest');
    expect(f.calls).toContain('install:1.1.0');
  });
});

describe('isNewerVersion', () => {
  it('compares numerically, not as text', () => {
    expect(isNewerVersion('13.10.0', '13.9.9')).toBe(true);
    expect(isNewerVersion('13.11.0', '13.11.0')).toBe(false);
    expect(isNewerVersion('13.11.0', '13.11.1')).toBe(false);
    expect(isNewerVersion('14.0.0', '13.99.99')).toBe(true);
    expect(isNewerVersion('13.11.0', '13.11.0-beta.1')).toBe(true);
  });
});

describe('syncInstalledPluginEntries', () => {
  const now = '2026-10-14T00:00:00.000Z';

  it('moves every MemSmith entry, user and per-project, to the new version and keeps the rest', () => {
    const registry = {
      version: 2,
      plugins: {
        'memsmith@shshalom': [
          { scope: 'user', installPath: '/c/13.10.3', version: '13.10.3', installedAt: 'a', lastUpdated: 'a' },
          { scope: 'local', projectPath: '/work/p', installPath: '/c/13.10.2', version: '13.10.2', installedAt: 'b', lastUpdated: 'b' },
        ],
        'other@x': [{ scope: 'user', version: '1.0.0' }],
      },
    };
    const { registry: next, changed } = syncInstalledPluginEntries(registry, '13.11.1', '/c/13.11.1', now);
    expect(changed).toBe(2);
    const entries = (next.plugins as any)['memsmith@shshalom'];
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ scope: 'local', projectPath: '/work/p', installPath: '/c/13.11.1', version: '13.11.1', installedAt: 'b', lastUpdated: now });
    expect((next.plugins as any)['other@x']).toEqual([{ scope: 'user', version: '1.0.0' }]);
  });

  it.skipIf(process.platform === 'win32')('recognizes a cache entry written through a symlinked home folder', () => {
    const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'ms-reg-')));
    mkdirSync(join(real, 'cache', '1.0.0'), { recursive: true });
    const linked = `${real}-link`;
    symlinkSync(real, linked);
    const registry = { plugins: { 'memsmith@shshalom': [{ scope: 'local', installPath: join(linked, 'cache', '1.0.0'), version: '1.0.0', installedAt: 'a', lastUpdated: 'a' }] } };
    try {
      const result = syncInstalledPluginEntries(registry, '1.1.0', join(real, 'cache', '1.1.0'), now);
      expect(result.skipped).toEqual([]);
      expect(result.changed).toBe(1);
    } finally {
      rmSync(linked, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('reports no change when every entry is already current', () => {
    const registry = { version: 2, plugins: { 'memsmith@shshalom': [{ scope: 'user', installPath: '/c/1', version: '1', installedAt: 'a', lastUpdated: 'a' }] } };
    expect(syncInstalledPluginEntries(registry, '1', '/c/1', now).changed).toBe(0);
  });

  it('leaves entries that point outside the MemSmith cache alone and drops stale commit hashes', () => {
    const registry = { plugins: { 'memsmith@shshalom': [
      { scope: 'local', projectPath: '/dev', installPath: '/src/memsmith/plugin', version: '0.0.0', installedAt: 'a', lastUpdated: 'a' },
      { scope: 'user', installPath: '/c/1.0.0', version: '1.0.0', gitCommitSha: 'abc', installedAt: 'a', lastUpdated: 'a' },
    ] } };
    const { registry: next, changed, skipped } = syncInstalledPluginEntries(registry, '1.1.0', '/c/1.1.0', now);
    const entries = (next.plugins as any)['memsmith@shshalom'];
    expect(changed).toBe(1);
    expect(skipped).toEqual(['/src/memsmith/plugin']);
    expect(entries[0].installPath).toBe('/src/memsmith/plugin');
    expect(entries[1]).toEqual({ scope: 'user', installPath: '/c/1.1.0', version: '1.1.0', installedAt: 'a', lastUpdated: now });
  });

  it('adds a user entry when MemSmith has none', () => {
    const { registry, changed } = syncInstalledPluginEntries({}, '1.1.0', '/c/1.1.0', now);
    expect(changed).toBe(1);
    expect((registry.plugins as any)['memsmith@shshalom']).toEqual([
      { scope: 'user', installPath: '/c/1.1.0', version: '1.1.0', installedAt: now, lastUpdated: now },
    ]);
  });
});

describe('withoutDevDependencies', () => {
  it('drops devDependencies and keeps everything npm needs for --omit=dev', async () => {
    const { withoutDevDependencies } = await import('../../src/npx-cli/commands/install.js');
    const manifest = { name: 'memsmith', version: '1.0.0', dependencies: { a: '1' }, optionalDependencies: { b: '2' }, devDependencies: { c: '3' } };
    expect(withoutDevDependencies(manifest)).toEqual({ name: 'memsmith', version: '1.0.0', dependencies: { a: '1' }, optionalDependencies: { b: '2' } });
  });
});
