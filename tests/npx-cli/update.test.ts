import { describe, it, expect } from 'bun:test';
import {
  runUpdate,
  switchToHaiku,
  isNewerVersion,
  parseGlobalCliListing,
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
    expect(f.text()).toContain('Restart Claude Code');
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

  describe('global memsmith command', () => {
    function withGlobal(global: string | null, o: { installOk?: boolean; installed?: string; registryChanged?: number; linkedFrom?: string; server?: ServerState } = {}) {
      const f = fake({ cli: '1.1.0', installed: o.installed ?? '1.0.0', registryChanged: o.registryChanged, server: o.server });
      f.deps.globalCli = {
        info: () => (global === null ? null : { version: global, ...(o.linkedFrom ? { linkedFrom: o.linkedFrom } : {}) }),
        install: (version) => {
          f.calls.push(`global:${version}`);
          return o.installOk === false ? { ok: false, message: 'EACCES: permission denied' } : { ok: true, message: '' };
        },
      };
      return f;
    }

    it('updates an older global command to the version it installed', async () => {
      const f = withGlobal('1.0.0');
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.calls).toContain('global:1.1.0');
      expect(f.calls.indexOf('global:1.1.0')).toBeGreaterThan(f.calls.indexOf('start'));
      expect(f.out).toContain('  CLI: 1.1.0');
    });

    it('updates the global command even when the plugin and server are already current', async () => {
      const f = withGlobal('1.0.0', { installed: '1.1.0', registryChanged: 0 });
      f.deps.serverState = async () => ({ kind: 'running', version: '1.1.0' });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.calls).toContain('global:1.1.0');
      expect(f.out).toContain('MemSmith updated to 1.1.0.');
      expect(f.out.join('\n')).not.toContain('Restart Claude Code');
    });

    it('leaves a current or newer global command alone', async () => {
      for (const version of ['1.1.0', '2.0.0']) {
        const f = withGlobal(version);
        await runUpdate([], f.deps);
        expect(f.calls.some((c) => c.startsWith('global:'))).toBe(false);
        expect(f.out).toContain(`  CLI: ${version}`);
      }
    });

    it('installs nothing globally when there is no global command', async () => {
      const f = withGlobal(null);
      await runUpdate([], f.deps);
      expect(f.calls.some((c) => c.startsWith('global:'))).toBe(false);
      expect(f.out.join('\n')).not.toContain('CLI:');
    });

    it('updates the global command when the server is remote or stopped', async () => {
      for (const server of [{ kind: 'remote', baseUrl: 'https://team.example' }, { kind: 'stopped' }] as ServerState[]) {
        const f = withGlobal('1.0.0', { server });
        expect(await runUpdate([], f.deps)).toBe(0);
        expect(f.calls).toContain('global:1.1.0');
      }
    });

    it('leaves a global command linked to a local checkout alone', async () => {
      const f = withGlobal('1.0.0', { linkedFrom: '/src/memsmith' });
      await runUpdate([], f.deps);
      expect(f.calls.some((c) => c.startsWith('global:'))).toBe(false);
      expect(f.out).toContain('  CLI: 1.0.0, linked to a local checkout (not updated)');
    });

    it('does not call a failed global update "already up to date"', async () => {
      const f = withGlobal('1.0.0', { installOk: false, installed: '1.1.0', registryChanged: 0 });
      f.deps.serverState = async () => ({ kind: 'running', version: '1.1.0' });
      await runUpdate([], f.deps);
      expect(f.out).not.toContain('MemSmith 1.1.0 is already up to date.');
      expect(f.out).toContain('The MemSmith 1.1.0 plugin and server are already up to date.');
    });

    it('finishes the update and prints the command to run when the global install fails', async () => {
      const f = withGlobal('1.0.0', { installOk: false });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.out).toContain('Updating the global memsmith command from 1.0.0 to 1.1.0…');
      expect(f.err.join('\n')).toContain('EACCES: permission denied');
      expect(f.err.join('\n')).toContain('npm install -g memsmith@1.1.0');
      expect(f.out).toContain('  CLI: 1.0.0 (not updated)');
    });

    it('leaves the global command to the newer CLI it re-runs', async () => {
      const f = withGlobal('1.0.0');
      f.deps.latestPublished = async () => '1.2.0';
      await runUpdate([], f.deps);
      expect(f.calls.some((c) => c.startsWith('global:'))).toBe(false);
    });
  });

  describe('login autostart offer', () => {
    const QUESTION = 'Start MemSmith when you log in?';

    function withLoginOffer(settings: Record<string, unknown>, o: { interactive?: boolean; answer?: boolean; registered?: boolean; enableOk?: boolean } = {}) {
      const f = fake({ installed: '1.1.0', cacheReady: true, registryChanged: 0 });
      const store = { ...settings };
      const prompts: string[] = [];
      const enables: number[] = [];
      f.deps.isInteractive = () => o.interactive ?? true;
      f.deps.confirm = async (message) => { prompts.push(message); return o.answer ?? true; };
      f.deps.readSettings = () => ({ ...store });
      f.deps.saveSettings = (updates) => { Object.assign(store, updates); return true; };
      f.deps.loginAutostart = {
        status: () => ({ registered: o.registered ?? false }),
        enable: () => { enables.push(1); return { ok: o.enableOk ?? true, message: o.enableOk === false ? 'bootstrap failed' : 'MemSmith starts when you log in.' }; },
      };
      return { ...f, store, prompts, enables };
    }

    it('offers once when nothing is registered, writes the marker on either answer, never offers again', async () => {
      for (const answer of [true, false]) {
        const f = withLoginOffer({ MEMSMITH_RUNTIME: 'local' }, { answer });
        expect(await runUpdate([], f.deps)).toBe(0);
        expect(f.prompts).toEqual([QUESTION]);
        expect(f.enables).toHaveLength(answer ? 1 : 0);
        expect(f.store.MEMSMITH_LOGIN_AUTOSTART_OFFERED).toBe('1');
        await runUpdate([], f.deps);
        expect(f.prompts).toHaveLength(1);
      }
    });

    it('never prompts when non-interactive', async () => {
      const f = withLoginOffer({}, { interactive: false });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.prompts).toHaveLength(0);
      expect(f.store.MEMSMITH_LOGIN_AUTOSTART_OFFERED).toBeUndefined();
    });

    it('does not offer when already registered or on the server runtime', async () => {
      const registered = withLoginOffer({}, { registered: true });
      await runUpdate([], registered.deps);
      expect(registered.prompts).toHaveLength(0);
      const server = withLoginOffer({ MEMSMITH_RUNTIME: 'server' });
      await runUpdate([], server.deps);
      expect(server.prompts).toHaveLength(0);
    });

    it('reports a failed registration without failing the update', async () => {
      const f = withLoginOffer({}, { enableOk: false });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.err.join('\n')).toContain('bootstrap failed');
      expect(f.err.join('\n')).toContain('memsmith autostart enable');
    });

    it('reports a throwing registration without failing the update', async () => {
      const f = withLoginOffer({});
      f.deps.loginAutostart!.enable = () => { throw new Error('disk full'); };
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.err.join('\n')).toContain('disk full');
    });
  });

  describe('Haiku switch offer', () => {
    const QUESTION = 'Switch memory generation to Claude Haiku 5.5, with a local gemma4:12b backup (8 GB download)? It needs an Anthropic API key and costs about $1 per 1,000 observations.';
    const TIP = 'Tip: run memsmith install to switch to Claude Haiku 5.5 with a local backup.';

    function withOffer(settings: Record<string, unknown>, o: { interactive?: boolean; answer?: boolean } = {}) {
      const f = fake({ installed: '1.1.0', cacheReady: true, registryChanged: 0 });
      const store = { ...settings };
      const prompts: string[] = [];
      const switches: number[] = [];
      f.deps.isInteractive = () => o.interactive ?? true;
      f.deps.confirm = async (message) => { prompts.push(message); return o.answer ?? true; };
      f.deps.switchToHaiku = async () => { switches.push(1); };
      f.deps.readSettings = () => ({ ...store });
      f.deps.saveSettings = (updates) => { Object.assign(store, updates); return true; };
      return { ...f, store, prompts, switches };
    }

    it('offers the switch once on an interactive update of an ollama install', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama' });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.prompts).toEqual([QUESTION]);
      expect(f.switches).toHaveLength(1);
      expect(f.store.MEMSMITH_GENERATION_SWITCH_OFFERED).toBe('1');
    });

    it('offers an older install that never set a provider', async () => {
      const f = withOffer({ MEMSMITH_RUNTIME: 'local' });
      await runUpdate([], f.deps);
      expect(f.prompts).toEqual([QUESTION]);
    });

    it('does not offer again after an answer', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama' }, { answer: false });
      await runUpdate([], f.deps);
      await runUpdate([], f.deps);
      expect(f.prompts).toHaveLength(1);
      expect(f.switches).toHaveLength(0);
    });

    it('does not offer on a claude install', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'claude' });
      await runUpdate([], f.deps);
      expect(f.prompts).toHaveLength(0);
      expect(f.text()).not.toContain(TIP);
    });

    it('non-interactive update prints the tip and never prompts', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama' }, { interactive: false });
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.prompts).toHaveLength(0);
      expect(f.switches).toHaveLength(0);
      expect(f.out.filter(line => line === TIP)).toHaveLength(1);
      expect(f.store.MEMSMITH_GENERATION_SWITCH_OFFERED).toBeUndefined();
    });

    it('declining changes no generation settings', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' }, { answer: false });
      await runUpdate([], f.deps);
      expect(f.store).toEqual({
        MEMSMITH_SERVER_PROVIDER: 'ollama',
        MEMSMITH_SERVER_MODEL: 'qwen2.5:14b',
        MEMSMITH_GENERATION_SWITCH_OFFERED: '1',
      });
    });

    it('reports a failed switch without failing the update', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama' });
      f.deps.switchToHaiku = async () => { throw new Error('disk full'); };
      expect(await runUpdate([], f.deps)).toBe(0);
      expect(f.err.join('\n')).toContain('disk full');
    });

    describe('accepting the switch', () => {
      function switchDeps(o: { hasKey?: boolean; keyEntered?: boolean } = {}) {
        const saved: Array<Record<string, string>> = [];
        const pulls: Array<[string, string]> = [];
        const out: string[] = [];
        const deps = {
          hasAnthropicKey: () => o.hasKey ?? false,
          promptAnthropicKey: async () => o.keyEntered ?? true,
          saveSettings: (updates: Record<string, string>) => { saved.push(updates); return true; },
          setupOllama: async (model: string, mode: string) => { pulls.push([model, mode]); },
          out: (line: string) => out.push(line),
        };
        return { deps, saved, pulls, out };
      }

      it('saves Claude Haiku 5.5 with the gemma4:12b backup and asks before the pull', async () => {
        const s = switchDeps();
        await switchToHaiku(s.deps);
        expect(s.saved).toEqual([{
          MEMSMITH_SERVER_PROVIDER: 'claude',
          MEMSMITH_SERVER_MODEL: 'claude-haiku-5-5',
          MEMSMITH_SERVER_FALLBACK: 'ollama',
          MEMSMITH_SERVER_FALLBACK_MODEL: 'gemma4:12b',
        }]);
        expect(s.pulls).toEqual([['gemma4:12b', 'interactive']]);
      });

      it('cancelling the key prompt changes nothing and says how to switch later', async () => {
        const s = switchDeps({ keyEntered: false });
        await switchToHaiku(s.deps);
        expect(s.saved).toEqual([]);
        expect(s.pulls).toEqual([]);
        expect(s.out).toEqual(['No changes made. Run memsmith install to switch later.']);
      });
    });

    it('does not offer when the update itself fails', async () => {
      const f = withOffer({ MEMSMITH_SERVER_PROVIDER: 'ollama' });
      f.deps.installPluginFiles = async () => { throw new Error('boom'); };
      expect(await runUpdate(['--force'], f.deps)).toBe(1);
      expect(f.prompts).toHaveLength(0);
    });
  });
});

describe('parseGlobalCliListing', () => {
  it('reads the version of a registry install', () => {
    expect(parseGlobalCliListing('{"dependencies":{"memsmith":{"version":"13.13.1","overridden":false}}}')).toEqual({ version: '13.13.1' });
  });

  it('marks an npm link install as linked so the update leaves it alone', () => {
    const json = '{"dependencies":{"memsmith":{"version":"13.12.0","resolved":"file:../../../dev/memsmith","overridden":false}}}';
    expect(parseGlobalCliListing(json)).toEqual({ version: '13.12.0', linkedFrom: '../../../dev/memsmith' });
  });

  it('reports no global install for an empty listing or unreadable output', () => {
    for (const json of ['{}', '', 'npm error something', '{"dependencies":{}}']) {
      expect(parseGlobalCliListing(json)).toBeNull();
    }
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
