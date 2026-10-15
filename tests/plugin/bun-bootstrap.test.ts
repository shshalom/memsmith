import { describe, it, expect } from 'bun:test';
// @ts-expect-error plain ESM plugin script without type declarations
import { ensureBun, bunInstallCommand } from '../../plugin/scripts/bun-bootstrap.js';

function harness(found: Array<string | null>, installThrows?: Error) {
  const logs: string[] = [];
  const commands: string[] = [];
  let call = 0;
  const result = (opts: { platform?: string; disabled?: boolean } = {}) => ensureBun({
    findBun: () => found[Math.min(call++, found.length - 1)],
    runInstaller: (command: string) => { commands.push(command); if (installThrows) throw installThrows; },
    log: (line: string) => logs.push(line),
    platform: opts.platform ?? 'darwin',
    disabled: opts.disabled ?? false,
  });
  return { result, logs, commands };
}

describe('ensureBun', () => {
  it('does nothing when Bun is already installed', () => {
    const h = harness(['/opt/homebrew/bin/bun']);
    expect(h.result()).toBe('/opt/homebrew/bin/bun');
    expect(h.commands).toEqual([]);
  });

  it('runs the official installer when Bun is missing and returns the new path', () => {
    const h = harness([null, '/home/u/.bun/bin/bun']);
    expect(h.result()).toBe('/home/u/.bun/bin/bun');
    expect(h.commands).toEqual(['curl -fsSL https://bun.sh/install | bash']);
    expect(h.logs.at(-1)).toBe('Bun installed.');
  });

  it('uses the PowerShell installer on Windows', () => {
    const h = harness([null, 'C:\\Users\\u\\.bun\\bin\\bun.exe']);
    h.result({ platform: 'win32' });
    expect(h.commands).toEqual([bunInstallCommand('win32')]);
    expect(h.commands[0]).toContain('install.ps1');
  });

  it('reports a failed install with manual steps instead of throwing', () => {
    const h = harness([null], new Error('curl: (6) Could not resolve host'));
    expect(h.result()).toBeNull();
    expect(h.logs.at(-1)).toContain('Could not resolve host');
    expect(h.logs.at(-1)).toContain('brew install oven-sh/bun/bun');
  });

  it('waits a day after a failed attempt instead of retrying on every session start', () => {
    const { mkdtempSync, rmSync } = require('fs');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const dir = mkdtempSync(join(tmpdir(), 'ms-bunstamp-'));
    const stamp = join(dir, '.bun-install-attempt');
    try {
      const commands: string[] = [];
      const run = (now: number) => ensureBun({
        findBun: () => null,
        runInstaller: (command: string) => { commands.push(command); throw new Error('offline'); },
        log: () => {},
        platform: 'linux',
        attemptStampPath: stamp,
        now,
      });
      const t0 = Date.now();
      run(t0);
      run(t0 + 60 * 60 * 1000);
      expect(commands).toHaveLength(1);
      run(t0 + 25 * 60 * 60 * 1000);
      expect(commands).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the install in CI', () => {
    let ran = false;
    expect(ensureBun({ findBun: () => null, runInstaller: () => { ran = true; }, log: () => {}, skipInstall: true })).toBeNull();
    expect(ran).toBe(false);
  });

  it('reports when the installer finished but bun still cannot be found', () => {
    const h = harness([null, null]);
    expect(h.result()).toBeNull();
    expect(h.logs.at(-1)).toContain('bun was not found');
  });

  it('never installs when the user opted out', () => {
    const h = harness([null]);
    expect(h.result({ disabled: true })).toBeNull();
    expect(h.commands).toEqual([]);
    expect(h.logs[0]).toContain('MEMSMITH_SKIP_BUN_INSTALL');
  });
});
