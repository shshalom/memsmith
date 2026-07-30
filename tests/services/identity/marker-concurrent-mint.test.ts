// SPDX-License-Identifier: Apache-2.0
//
// ensureProjectIdentity mints a project's durable identity: read the marker, and
// if there is none, generate uuids and write one. That is check-then-act with no
// mutual exclusion.
//
// An in-process probe (Promise.all over ensureProjectIdentity) reports this as
// SAFE — 3/3 trials agreed — because the fs calls are synchronous and the event
// loop never interleaves them. That result is a false negative, and acting on it
// was a mistake: hook processes are SEPARATE PROCESSES.
//
// Measured with 6 concurrent hook processes in one fresh project: up to 4
// distinct projectIds, and only 3 of 6 sessions agreed with the marker on disk.
// The disagreeing sessions write their events and observations under a projectId
// that nothing points at — orphaned memory, invisible, in the project the user
// is actively working in. That is worse than the credential races: a lost key
// degrades capture loudly enough to notice, a wrong projectId captures happily
// into nowhere.
//
// So this test spawns REAL PROCESSES. An in-process version of it would pass
// against the unfixed code and prove nothing.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { ensureProjectIdentity, readProjectMarker } from '../../../src/services/identity/project-identity.js';

const REPO = join(import.meta.dir, '..', '..', '..');

/** A hook process that mints identity in `cwd` and prints the id it believes it owns. */
const WORKER = `
import { ensureProjectIdentity } from ${JSON.stringify(join(REPO, 'src/services/identity/project-identity.ts'))};
const pool = { async query() { return { rows: [], rowCount: 0 }; } };
const ids = await ensureProjectIdentity(pool, process.argv[2]);
console.log(ids.projectId);
`;

function fakePool() {
  return { async query() { return { rows: [] as unknown[], rowCount: 0 }; } };
}

describe('concurrent project identity mint', () => {
  it('all concurrent hook PROCESSES agree on one projectId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-marker-race-'));
    try {
      const workerPath = join(dir, 'worker.ts');
      writeFileSync(workerPath, WORKER, 'utf-8');
      const project = join(dir, 'project');

      // Six hook processes racing in one fresh project, no stagger.
      //
      // spawn, NOT spawnSync: spawnSync runs each child to completion before
      // starting the next, so the processes never overlap and the test passes
      // against the racy code — it proves nothing. (Verified: an earlier
      // spawnSync version of this test passed on the unfixed implementation.)
      const reported = (
        await Promise.all(
          Array.from({ length: 6 }, () =>
            new Promise<string>(resolve => {
              const child = spawn('bun', [workerPath, project], { encoding: 'utf-8' } as never);
              let out = '';
              child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
              child.on('close', () => resolve(out.trim().split('\n').pop()?.trim() ?? ''));
              child.on('error', () => resolve(''));
            }),
          ),
        )
      ).filter(Boolean);

      // Every process that completed must report the SAME id...
      expect(reported.length).toBeGreaterThan(1);
      expect(new Set(reported).size).toBe(1);

      // ...and that id must be the one actually persisted, or the sessions
      // disagreeing with the file write their memory into nowhere.
      const onDisk = readProjectMarker(project);
      expect(onDisk).not.toBeNull();
      expect(reported.every(id => id === onDisk!.projectId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('never overwrites an existing marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-marker-keep-'));
    try {
      const first = await ensureProjectIdentity(fakePool() as never, dir);
      const second = await ensureProjectIdentity(fakePool() as never, dir);
      expect(second.projectId).toBe(first.projectId);
      expect(second.teamId).toBe(first.teamId);
      expect(readProjectMarker(dir)!.projectId).toBe(first.projectId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers when the marker file exists but is unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-marker-corrupt-'));
    try {
      // A truncated/corrupt marker must not leave the project identity-less:
      // without a marker there is no project at all. Replacing it is the
      // lesser evil, and is the one case where overwriting is correct.
      const markerDir = join(dir, '.memsmith');
      rmSync(markerDir, { recursive: true, force: true });
      await ensureProjectIdentity(fakePool() as never, dir);
      writeFileSync(join(dir, '.memsmith', 'project.json'), '{ broken', 'utf-8');

      const repaired = await ensureProjectIdentity(fakePool() as never, dir);
      expect(repaired.projectId).toBeTruthy();
      expect(readProjectMarker(dir)!.projectId).toBe(repaired.projectId);
      // And the recovered marker must be valid JSON, not left broken.
      expect(() => JSON.parse(readFileSync(join(dir, '.memsmith', 'project.json'), 'utf-8'))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
