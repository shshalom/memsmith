import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { exitAfterFlush } from '../../src/npx-cli/utils/exit.js';

function fakeStream(opts: { delayMs?: number; fail?: boolean } = {}): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      if (opts.fail) return cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      setTimeout(cb, opts.delayMs ?? 0);
    },
  });
}

describe('exitAfterFlush', () => {
  it('exits only after output already written has drained', async () => {
    const events: string[] = [];
    const stdout = fakeStream({ delayMs: 30 });
    stdout.write('payload', () => events.push('drained'));
    await exitAfterFlush(3, { stdout, stderr: fakeStream(), exit: ((c: number) => { events.push(`exit ${c}`); }) as never });
    expect(events).toEqual(['drained', 'exit 3']);
  });

  it('exits normally when the reader closed the pipe early', async () => {
    const exits: number[] = [];
    await exitAfterFlush(0, { stdout: fakeStream({ fail: true }), stderr: fakeStream(), exit: ((c: number) => { exits.push(c); }) as never });
    expect(exits).toEqual([0]);
  });

  it('is how the CLI router exits after a command returns', () => {
    const router = readFileSync(join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'index.ts'), 'utf8');
    expect(router).not.toMatch(/process\.exit\(\s*await\b/);
    expect(router).toContain('await exitAfterFlush(await runProjectsCommand(');
  });
});

// On macOS, Node writes to a pipe asynchronously, so a plain exit loses what a
// slow reader hasn't taken: `memsmith projects --json | jq` stopped at 64 KiB.
const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
describe.skipIf(process.platform !== 'darwin' || node.status !== 0)('exitAfterFlush through a real pipe', () => {
  const SIZE = 300_000;
  const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'exit-flush', 'write-and-exit.mjs');
  let dir: string;
  let helper: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ms-exit-'));
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, '..', '..', 'src', 'npx-cli', 'utils', 'exit.ts')], outdir: dir, target: 'node' });
    helper = built.outputs[0].path;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function piped(mode: 'plain' | 'flush', reader: string): { status: number | null; stdout: string; stderr: string } {
    return spawnSync('bash', ['-o', 'pipefail', '-c', `node "${FIXTURE}" ${SIZE} ${mode} "${helper}" | ${reader}`], { encoding: 'utf8' });
  }

  it('delivers all output to a slow reader', () => {
    const run = piped('flush', '(sleep 0.3; wc -c)');
    expect(run.status).toBe(0);
    expect(Number(run.stdout.trim())).toBe(SIZE);
  });

  it('is needed: a plain exit loses output a slow reader has not taken', () => {
    const run = piped('plain', '(sleep 0.3; wc -c)');
    expect(run.status).toBe(0);
    expect(Number(run.stdout.trim())).toBeLessThan(SIZE);
  });

  it('exits quietly when the reader stops early', () => {
    const run = piped('flush', 'head -c 10 >/dev/null');
    expect(run.stderr).not.toContain('EPIPE');
  });
});
