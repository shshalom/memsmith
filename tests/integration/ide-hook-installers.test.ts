import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

// Each installer runs in a child process with a throwaway HOME: the installers
// compute their config paths from homedir() at import time, so an in-process
// import would write to the real machine. The child gets an unreachable server
// URL so no installer step can talk to a running MemSmith server.
const REPO = join(import.meta.dir, '..', '..');
const PLUGIN_ROOT = join(REPO, 'plugin');
const SERVER_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'server-service.cjs');

let home: string;

function runInstaller(modulePath: string, call: string): { status: number | null; output: string } {
  const script = `const m = await import(${JSON.stringify(modulePath)}); process.exit(await m.${call});`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: home,
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      MEMSMITH_DATA_DIR: join(home, '.memsmith'),
      MEMSMITH_SERVER_URL: 'http://127.0.0.1:1',
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function hookCommands(config: unknown): string[] {
  const commands: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'command' && typeof value === 'string') commands.push(value);
        else walk(value);
      }
    }
  };
  walk(config);
  return commands;
}

function expectServerScriptCommands(commands: string[], platform: string) {
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(command).not.toContain('worker-service');
    expect(command).toContain(`"${SERVER_SCRIPT}" hook ${platform} `);
  }
}

beforeAll(() => {
  expect(existsSync(SERVER_SCRIPT)).toBe(true);
  home = mkdtempSync(join(tmpdir(), 'memsmith-ide-installers-'));
  mkdirSync(join(home, '.gemini'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'settings.json'), '{}');
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('IDE hook installers', () => {
  it('Cursor writes hooks that run the shipped server script', () => {
    const { status, output } = runInstaller(
      join(REPO, 'src/services/integrations/CursorHooksInstaller.ts'),
      "installCursorHooks('user')",
    );
    expect(status, output).toBe(0);
    const config = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf-8'));
    expectServerScriptCommands(hookCommands(config), 'cursor');
  });

  it('Antigravity CLI writes hooks that run the shipped server script', () => {
    const { status, output } = runInstaller(
      join(REPO, 'src/services/integrations/AntigravityCliHooksInstaller.ts'),
      'installAntigravityCliHooks()',
    );
    expect(status, output).toBe(0);
    const config = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf-8'));
    expectServerScriptCommands(hookCommands(config.hooks), 'antigravity-cli');
  });

  it('Windsurf writes hooks that run the shipped server script', () => {
    const { status, output } = runInstaller(
      join(REPO, 'src/services/integrations/WindsurfHooksInstaller.ts'),
      'installWindsurfHooks()',
    );
    expect(status, output).toBe(0);
    const config = JSON.parse(readFileSync(join(home, '.codeium', 'windsurf', 'hooks.json'), 'utf-8'));
    expectServerScriptCommands(hookCommands(config), 'windsurf');
  });
});
