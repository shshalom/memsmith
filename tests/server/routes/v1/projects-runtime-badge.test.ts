// SPDX-License-Identifier: Apache-2.0
//
// GET /v1/projects reported runtime from the SERVER's own marker:
//
//   const currentMarker = readServerProjectMarker(process.cwd())
//   const isServerProject = currentMarker?.projectId === row.id
//   const runtime = isServerProject && currentMarker.runtime === 'server' ? 'team' : 'local'
//
// So ONLY the project the server was launched from could ever display "Team".
// Every other project was hardcoded 'local' regardless of its actual marker —
// which is why a freshly converted project still showed "Local" in the switcher
// and the GO TEAM button stayed visible on a project already in team mode.
//
// This is the fourth instance of the server-cwd pattern that caused tonight's
// cross-project copy. It survived my own audit because I checked that the
// endpoint reads authContext SOMEWHERE (it does, for isCurrent) instead of
// checking the field the bug was actually in.
//
// Each project's runtime now comes from ITS OWN marker, located via the path
// recorded in projects.metadata. The path is not authoritative (a project can
// move), so a marker whose projectId no longer matches is ignored rather than
// trusted.
import { describe, it, expect } from 'bun:test';
import { resolveProjectRuntime } from '../../../../src/server/routes/v1/project-runtime.js';
import { PROJECT_PATH_KEY } from '../../../../src/services/identity/project-identity.js';

const TEMP = '42d7997d-5708-4e26-9e7c-b6f2247085a8';
const DOGFOOD = '5fc024f0-0994-4f1d-baed-300d9b4d3416';

function readerFor(markers: Record<string, { projectId: string; runtime?: string }>) {
  return (path: string) => (markers[path] ?? null) as never;
}

describe('resolveProjectRuntime', () => {
  it('reports team for a converted project that is NOT the server\'s own', () => {
    // The exact case that displayed "Local" after a successful convert.
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/private/tmp/ms-p3-fresh' } },
      readerFor({ '/private/tmp/ms-p3-fresh': { projectId: TEMP, runtime: 'server' } }),
    );
    expect(runtime).toBe('team');
  });

  it('reports local for a project whose marker has no runtime field', () => {
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/p/a' } },
      readerFor({ '/p/a': { projectId: TEMP } }),
    );
    expect(runtime).toBe('local');
  });

  it('reports local for a project explicitly on the local runtime', () => {
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/p/a' } },
      readerFor({ '/p/a': { projectId: TEMP, runtime: 'local' } }),
    );
    expect(runtime).toBe('local');
  });

  it('does not trust a marker whose projectId no longer matches', () => {
    // The recorded path is a hint, not authority: a project can be moved and
    // another can take its directory. Reading a different project's runtime here
    // is how one project's state gets attributed to another.
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/p/a' } },
      readerFor({ '/p/a': { projectId: DOGFOOD, runtime: 'server' } }),
    );
    expect(runtime).toBe('local');
  });

  it('reports local when no path was ever recorded', () => {
    // Projects minted before path recording. They heal on their next session;
    // until then "local" is the safe answer, not a guess from the server's cwd.
    expect(resolveProjectRuntime({ projectId: TEMP, metadata: {} }, readerFor({}))).toBe('local');
    expect(resolveProjectRuntime({ projectId: TEMP, metadata: null }, readerFor({}))).toBe('local');
  });

  it('reports local when the recorded path no longer exists', () => {
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/deleted' } },
      readerFor({}),
    );
    expect(runtime).toBe('local');
  });

  it('never throws when the reader fails', () => {
    // This runs per row on a dashboard list; one unreadable marker must not 500
    // the whole project switcher.
    const runtime = resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/p/a' } },
      () => { throw new Error('EACCES'); },
    );
    expect(runtime).toBe('local');
  });

  it('ignores a non-string path', () => {
    for (const bad of [42, null, {}, []]) {
      const runtime = resolveProjectRuntime(
        { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: bad } },
        readerFor({}),
      );
      expect(runtime).toBe('local');
    }
  });

  it('resolves each project independently', () => {
    // The whole point: two projects, different runtimes, one server.
    const reader = readerFor({
      '/private/tmp/ms-p3-fresh': { projectId: TEMP, runtime: 'server' },
      '/Users/x/MemSmith': { projectId: DOGFOOD, runtime: 'local' },
    });
    expect(resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/private/tmp/ms-p3-fresh' } }, reader,
    )).toBe('team');
    expect(resolveProjectRuntime(
      { projectId: DOGFOOD, metadata: { [PROJECT_PATH_KEY]: '/Users/x/MemSmith' } }, reader,
    )).toBe('local');
  });

  it('accepts the legacy server-beta literal as team', () => {
    // Markers written before the rename carry 'server-beta', and
    // normalizeRuntime still honours it. Matching only 'server' silently
    // demoted a real team project to local — which hides its team badge and
    // its Join button.
    const reader = readerFor({ '/p': { projectId: TEMP, runtime: 'server-beta' } });
    expect(resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '/p' } }, reader,
    )).toBe('team');
  });

  it('says local for an unrecorded path instead of guessing from the server', () => {
    // THE REGRESSION GUARD. A fallback was added here that read the marker at
    // `MEMSMITH_PROJECT_CWD ?? process.cwd()` — the SERVER's directory. One
    // server serves every project, so that names some unrelated project: this
    // repo's memory classifies exactly that as a cross-project leak, and it had
    // already been fixed once in settingsRoutes ("never from the server's cwd").
    //
    // A reader that throws on ANY path proves the resolver never consulted one:
    // with no recorded path it must answer without reading anything at all.
    const exploding = (() => { throw new Error('must not read any path'); }) as never;
    expect(resolveProjectRuntime({ projectId: TEMP, metadata: null }, exploding)).toBe('local');
    expect(resolveProjectRuntime({ projectId: TEMP, metadata: {} }, exploding)).toBe('local');
    expect(resolveProjectRuntime(
      { projectId: TEMP, metadata: { [PROJECT_PATH_KEY]: '   ' } }, exploding,
    )).toBe('local');
  });
});
