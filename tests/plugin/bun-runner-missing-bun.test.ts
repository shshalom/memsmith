import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const PLUGIN = resolve(import.meta.dir, '../../plugin');
const RUNNER = join(PLUGIN, 'scripts/bun-runner.js');
const SERVICE = join(PLUGIN, 'scripts/server-service.cjs');
const NODE = spawnSync('which', ['node'], { encoding: 'utf-8' }).stdout.trim();
const SYSTEM_BUN = ['/usr/local/bin/bun', '/opt/homebrew/bin/bun', '/home/linuxbrew/.linuxbrew/bin/bun'].some(existsSync);

// Fresh-install rehearsal (2026-10-07): on a machine without Bun every hook
// exited 1, so Claude Code reported a hook error on every prompt and tool call.
function runWithoutBun(...tail: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'ms-nobun-'));
  try {
    return spawnSync(NODE, [RUNNER, SERVICE, ...tail], {
      env: { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_PLUGIN_ROOT: PLUGIN },
      input: '{}',
      encoding: 'utf-8',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(SYSTEM_BUN || !NODE)('bun-runner without Bun', () => {
  it('tells the user how to turn MemSmith on from the session-start context hook', () => {
    const result = runWithoutBun('hook', 'claude-code', 'context');
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.systemMessage).toContain('install Bun');
  });

  it('keeps the start hook stdout empty so its trailing JSON stays valid', () => {
    const result = runWithoutBun('start');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('install Bun');
  });

  it('skips every other hook without an error', () => {
    const result = runWithoutBun('hook', 'claude-code', 'observation');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('still fails a manual CLI command', () => {
    expect(runWithoutBun('status').status).toBe(1);
  });
});
