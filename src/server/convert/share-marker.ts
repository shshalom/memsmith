// SPDX-License-Identifier: Apache-2.0
//
// Make a converted project's marker shippable to teammates.
//
// `.memsmith/` is gitignored by default, and for a LOCAL project that is
// correct: the identity is per-checkout, and one machine's identity has no
// business in a shared repo. Conversion changes what the marker means. From
// that moment teamId/projectId/serverUrl are identical for everyone by
// definition — it stops being machine state and becomes shared project
// configuration, the thing a teammate needs in order to know there is a team
// here at all.
//
// While it stayed ignored, a clone received nothing: install minted a fresh
// unrelated local identity, and the entire joiner path was unreachable because
// there was no team to recognise.
//
// THE CREDENTIAL IS NOT AFFECTED. The marker is a non-secret pointer; the key
// lives only in ~/.memsmith/credentials.json (0600) and never enters a repo.
// ProjectMarker has no credential field, and its own `note` says so.
//
// MECHANICAL TRAP (verified against real git): a negation cannot re-include a
// file inside an ignored DIRECTORY. Given `.memsmith/`, git never descends to
// consider `!.memsmith/project.json`, so the marker stays ignored and the whole
// change silently does nothing. The directory rule must become `.memsmith/*`.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Ignore everything under .memsmith/ ... */
const IGNORE_ALL = '.memsmith/*';
/** ...except the marker, which teammates need. */
const KEEP_MARKER = '!.memsmith/project.json';
const EXPLANATION =
  '# MemSmith team identity — non-secret pointer, shared with teammates.'
  + ' The access credential lives in ~/.memsmith, never here.';

export interface ShareMarkerResult {
  /** True when the file was written. False when already correct, or on failure. */
  changed: boolean;
  /** Why nothing was written, when the cause was a failure rather than a no-op. */
  reason?: string;
}

/**
 * Ensure `<cwd>/.gitignore` permits `.memsmith/project.json`. NEVER throws.
 *
 * By the time this runs the convert has already succeeded and the project's
 * rows are on the remote, so a bookkeeping failure must not be reported to the
 * user as a failed convert. The caller logs the reason and tells the user how
 * to do it by hand; a retry is idempotent.
 */
export function shareMarkerInGit(cwd: string): ShareMarkerResult {
  const path = join(cwd, '.gitignore');
  try {
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const lines = existing.split('\n');

    // Already correct — do not append a second copy on every convert.
    if (lines.some(l => l.trim() === KEEP_MARKER)) return { changed: false };

    // Drop any blanket rule that would keep git from ever descending into the
    // directory. Matches `.memsmith/` and `.memsmith` with optional leading
    // slash — all of which defeat the negation below.
    const kept = lines.filter(l => !/^\/?\.memsmith\/?$/.test(l.trim()));

    // Guard the join: a file whose last line lacks a newline would otherwise
    // become `dist/.memsmith/*`, a rule that ignores neither.
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();

    const additions = kept.length > 0
      ? ['', EXPLANATION, IGNORE_ALL, KEEP_MARKER, '']
      : [EXPLANATION, IGNORE_ALL, KEEP_MARKER, ''];

    writeFileSync(path, [...kept, ...additions].join('\n'), 'utf-8');
    return { changed: true };
  } catch (error) {
    return {
      changed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
