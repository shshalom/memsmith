// SPDX-License-Identifier: Apache-2.0
//
// A converted project's marker has to REACH the teammate.
//
// `.memsmith/` is gitignored by default, and rightly so for a local project:
// the identity is per-checkout, and one machine's identity must not ship in a
// shared repo. But conversion changes what the marker means. From that moment
// teamId/projectId/serverUrl are the same for everyone by definition, and the
// marker stops being machine state and becomes shared project configuration.
//
// While it stayed ignored, a teammate cloning the repo received nothing, so
// install minted a fresh unrelated local identity and there was no team to
// recognise — the whole joiner path was unreachable. The credential is NOT
// affected: it lives only in ~/.memsmith/credentials.json and never enters a
// repo.
//
// MECHANICAL TRAP, verified against real git: a negation cannot re-include a
// file inside an ignored DIRECTORY. `.memsmith/` + `!.memsmith/project.json`
// leaves the marker ignored; git never descends into the directory to consider
// the exception. The rule must be `.memsmith/*` + `!.memsmith/project.json`.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { shareMarkerInGit } from '../../../src/server/convert/share-marker.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-gi-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const read = () => readFileSync(join(dir, '.gitignore'), 'utf-8');

describe('shareMarkerInGit', () => {
  it('rewrites a directory-wide ignore into an ignore-all-but-the-marker rule', () => {
    // The exact rule MemSmith itself ships. A bare negation after `.memsmith/`
    // is a no-op in git, so the directory line must become `.memsmith/*`.
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.memsmith/\n', 'utf-8');
    expect(shareMarkerInGit(dir).changed).toBe(true);

    const out = read();
    expect(out).toContain('.memsmith/*');
    expect(out).toContain('!.memsmith/project.json');
    // The blanket directory rule must be GONE, or it still wins.
    expect(out.split('\n')).not.toContain('.memsmith/');
    // Unrelated rules survive.
    expect(out).toContain('node_modules/');
  });

  it('is idempotent — a second convert does not duplicate the rule', () => {
    writeFileSync(join(dir, '.gitignore'), '.memsmith/\n', 'utf-8');
    shareMarkerInGit(dir);
    const first = read();
    expect(shareMarkerInGit(dir).changed).toBe(false);
    expect(read()).toBe(first);
    // One negation, not two.
    expect(read().split('!.memsmith/project.json').length - 1).toBe(1);
  });

  it('creates a .gitignore when the project has none', () => {
    expect(shareMarkerInGit(dir).changed).toBe(true);
    expect(read()).toContain('!.memsmith/project.json');
  });

  it('appends to an existing .gitignore that never mentioned .memsmith', () => {
    writeFileSync(join(dir, '.gitignore'), 'dist/\n', 'utf-8');
    expect(shareMarkerInGit(dir).changed).toBe(true);
    expect(read()).toContain('dist/');
    expect(read()).toContain('!.memsmith/project.json');
  });

  it('leaves other .memsmith entries ignored', () => {
    // The marker's siblings (e.g. project.json.orphan-*.bak) must stay out of
    // the repo. `.memsmith/*` plus ONE negation is what keeps them out.
    shareMarkerInGit(dir);
    const lines = read().split('\n');
    expect(lines.filter(l => l.startsWith('!')).length).toBe(1);
  });

  it('reports failure instead of throwing when the file cannot be written', () => {
    // Convert has already succeeded by the time this runs — the data is on the
    // remote. A bookkeeping failure must never surface as a failed convert.
    const missing = join(dir, 'no', 'such', 'dir');
    const result = shareMarkerInGit(missing);
    expect(result.changed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(existsSync(join(missing, '.gitignore'))).toBe(false);
  });

  it('preserves a trailing newline and does not glue rules onto the last line', () => {
    // A .gitignore whose last line lacks a newline would otherwise become
    // `dist/.memsmith/*`, silently ignoring neither.
    writeFileSync(join(dir, '.gitignore'), 'dist/', 'utf-8');
    shareMarkerInGit(dir);
    expect(read()).not.toContain('dist/.memsmith');
    expect(read().split('\n')).toContain('dist/');
  });
});
