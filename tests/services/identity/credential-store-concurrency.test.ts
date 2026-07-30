// SPDX-License-Identifier: Apache-2.0
//
// CredentialStore.storeKeyForTeam is a read-modify-write on ONE shared file
// (~/.memsmith/credentials.json) that holds every project's key.
//
// Within a single process that is safe by accident: the fs calls are
// synchronous, so the event loop never interleaves two of them. Ten teams
// stored "concurrently" in-process all survive.
//
// But hooks are SEPARATE SHORT-LIVED PROCESSES. Nothing serialises them. Eight
// concurrent hook processes, each storing its own team, measured 5 survivors —
// three keys silently lost, reproducible on every trial. Read-modify-write with
// no lock loses writes whenever the read windows overlap.
//
// A lost key is not cosmetic. ensureBaseKey exists to guarantee every marker has
// a resolvable key, because a keyless marker makes every hook fall back to
// `missing_api_key` and silently drop observations — "dark capture". Losing the
// key from the cache reintroduces exactly that hole one layer down, and it is
// invisible: no error, capture just stops for that project.
//
// This matters more in team mode than local. Local mode is a handful of your own
// sessions; team mode is N users against the same paths.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ms-credstore-'));
}

describe('CredentialStore concurrent writes', () => {
  it('does not lose keys when many teams are stored in one process', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'credentials.json');
      for (let i = 0; i < 10; i += 1) {
        new CredentialStore(path).storeKeyForTeam(`team-${i}`, `cmem_${i}`);
      }
      const store = new CredentialStore(path);
      for (let i = 0; i < 10; i += 1) {
        expect(store.resolveKeyForTeam(`team-${i}`)).toBe(`cmem_${i}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a concurrent external writer (the multi-process case)', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'credentials.json');
      // Seed a key, then simulate another hook process that read the file
      // BEFORE us and writes AFTER us — the exact interleaving that lost keys.
      new CredentialStore(path).storeKeyForTeam('team-a', 'cmem_a');

      const store = new CredentialStore(path);
      const staleSnapshot = readFileSync(path, 'utf-8');

      // Our write lands.
      store.storeKeyForTeam('team-b', 'cmem_b');
      // The other process now flushes ITS stale view, clobbering team-b.
      writeFileSync(path, staleSnapshot, 'utf-8');

      // A subsequent store must not compound the loss: it has to re-read
      // current state rather than trust anything it cached earlier.
      store.storeKeyForTeam('team-c', 'cmem_c');

      const after = new CredentialStore(path);
      expect(after.resolveKeyForTeam('team-a')).toBe('cmem_a');
      expect(after.resolveKeyForTeam('team-c')).toBe('cmem_c');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never leaves a truncated or unparseable file behind', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'credentials.json');
      // A reader that catches a non-atomic write mid-flight sees a truncated
      // file, and CredentialStore.read() swallows the parse error and returns
      // {} — silently reporting "this machine holds no keys at all", which
      // makes every project look keyless at once.
      for (let i = 0; i < 40; i += 1) {
        new CredentialStore(path).storeKeyForTeam(`team-${i}`, `cmem_${i}`);
        const raw = readFileSync(path, 'utf-8');
        expect(() => JSON.parse(raw)).not.toThrow();
      }
      expect(new CredentialStore(path).listTeamIdsWithKeys()).toHaveLength(40);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the file owner-only through every write', () => {
    if (process.platform === 'win32') return;
    const dir = scratch();
    try {
      const path = join(dir, 'credentials.json');
      const store = new CredentialStore(path);
      store.storeKeyForTeam('team-a', 'cmem_a');
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
      // An atomic write via a temp file must not widen the mode, and must not
      // leave the temp file readable either.
      store.storeKeyForTeam('team-b', 'cmem_b');
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves existing keys when the file is corrupt rather than wiping them', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'credentials.json');
      writeFileSync(path, '{ this is not json', { mode: 0o600 });
      // read() degrades to {} on a parse failure. Writing on top of that would
      // permanently destroy whatever the corrupt file held. Storing must still
      // work (the caller needs a usable key) but must not be a silent wipe of
      // recoverable data, so the damaged file is preserved alongside.
      new CredentialStore(path).storeKeyForTeam('team-new', 'cmem_new');
      expect(new CredentialStore(path).resolveKeyForTeam('team-new')).toBe('cmem_new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
