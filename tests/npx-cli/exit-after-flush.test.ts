import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'exit-flush', 'write-and-exit.ts');
const SIZE = 300_000;

// A slow reader leaves output in the pipe when the CLI exits, which is how
// `memsmith projects --json | jq` lost everything past 64 KiB.
function pipedLength(mode: 'plain' | 'flush'): number {
  const run = spawnSync('sh', ['-c', `node "${FIXTURE}" ${SIZE} ${mode} | (sleep 0.3; wc -c)`], { encoding: 'utf8' });
  return Number(run.stdout.trim());
}

describe('exitAfterFlush', () => {
  it('delivers all piped output before the process exits', () => {
    expect(pipedLength('flush')).toBe(SIZE);
  });

  it('is needed: a plain exit loses output a slow pipe has not read', () => {
    expect(pipedLength('plain')).toBeLessThan(SIZE);
  });

  it('is how the CLI router exits after a command returns', () => {
    const router = readFileSync(join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'index.ts'), 'utf8');
    expect(router).not.toMatch(/process\.exit\(\s*await\b/);
    expect(router).toContain('await exitAfterFlush(await runProjectsCommand(');
  });
});
