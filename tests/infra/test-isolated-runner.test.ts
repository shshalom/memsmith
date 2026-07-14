import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RUNNER = join(import.meta.dir, '..', '..', 'scripts', 'test-isolated.cjs');

function runOn(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [RUNNER, dir], { encoding: 'utf-8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('test-isolated runner', () => {
  it('exits 0 when all files pass and non-zero when a file fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iso-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.test.ts'), `import {test,expect} from 'bun:test'; test('ok',()=>expect(1).toBe(1));`);
    const pass = runOn(dir);
    expect(pass.code).toBe(0);

    writeFileSync(join(dir, 'bad.test.ts'), `import {test,expect} from 'bun:test'; test('bad',()=>expect(1).toBe(2));`);
    const fail = runOn(dir);
    expect(fail.code).not.toBe(0);
    expect(fail.out).toContain('bad.test.ts');
    rmSync(dir, { recursive: true, force: true });
  });
});
