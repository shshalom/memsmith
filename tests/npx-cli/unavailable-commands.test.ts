import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// adopt and cleanup ran subcommands of the retired worker script. Until they
// move to the server script, the CLI must say so plainly instead of failing
// with a missing-file error, and --help must not advertise them.
const CLI = join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'index.ts');
let home: string;

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: home,
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      MEMSMITH_DATA_DIR: join(home, '.memsmith'),
    },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'memsmith-unavailable-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('commands that are not available in this version', () => {
  for (const command of ['adopt', 'cleanup']) {
    it(`${command} exits 1 with a one-line not-available message`, () => {
      const { status, stderr } = cli(command);
      expect(status).toBe(1);
      expect(stderr.trim().split('\n')).toEqual([`memsmith ${command} is not available in this version.`]);
    });
  }

  // --help needs the built bundle to read the version, so check the help source.
  it('--help does not advertise adopt or cleanup', () => {
    const source = readFileSync(CLI, 'utf-8');
    const help = source.slice(source.indexOf('Install Commands'), source.indexOf('IDE Identifiers'));
    expect(help).toContain('memsmith start');
    expect(help).not.toMatch(/memsmith (adopt|cleanup)\b/);
  });
});
