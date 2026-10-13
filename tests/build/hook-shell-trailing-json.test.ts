import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

// Reported from a fresh install (2026-10-07): the SessionStart `start` hook
// printed the server's own status line AND the trailing continue marker, and
// Claude Code rejected the two concatenated objects as invalid JSON.
describe('trailingJson hook stdout', () => {
  it('emits exactly one JSON document even when the command writes JSON to stdout', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-hook-json-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      const script = join(root, 'scripts', 'server-service.cjs');
      writeFileSync(script, '');
      const noisy = join(root, 'noisy.sh');
      writeFileSync(noisy, `#!/bin/sh\necho '{"status":"starting","pid":1,"port":38879}'\n`);
      chmodSync(noisy, 0o755);

      const command = buildShellCommand({
        host: 'claude-code',
        requireFile: 'server-service.cjs',
        trailingCommand: [noisy],
        trailingJson: { continue: true, suppressOutput: true },
        notFoundMessage: 'memsmith: plugin scripts not found',
      });

      const result = spawnSync('bash', ['-c', command], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
        encoding: 'utf-8',
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ continue: true, suppressOutput: true });
      expect(result.stderr).toContain('"status":"starting"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
