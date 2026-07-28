// SPDX-License-Identifier: Apache-2.0
//
// runConvert no longer flips the project itself. It used to call a `flip`
// callback that wrote the project's .memsmith/project.json and its
// ~/.memsmith/credentials.json entry — filesystem work, done by the server, using
// a cwd the server had no reliable way to know. That only functioned because
// local and server are the same machine; against a real remote team server the
// cwd is a directory on someone else's box. And the cwd it actually used was the
// SERVER's, so it would have flipped the wrong project's marker.
//
// Now the server does database work only and returns `join` — the teamId,
// projectId, serverUrl and apiKey the project needs — for the process that runs
// IN that project to apply. These tests pin that split.
import { describe, it, expect } from 'bun:test';
import { runConvert, type ConvertDeps } from '../../../src/server/convert/convert-service.js';
import { COPY_TABLES, type CopyDeps } from '../../../src/server/convert/copy-engine.js';

function baseCopyDeps(remoteShort = false): CopyDeps {
  const local: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  local.observations = [{ id: 'o1', metadata: {}, content: 'a' }];
  const remote: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  return {
    readRows: async (t) => local[t] ?? [],
    upsertRows: async (t, rows) => { if (!(remoteShort && t === 'observations')) remote[t].push(...rows); },
    countRows: async (which, t) => (which === 'local' ? local[t] : remote[t]).length,
  };
}

const baseInput = {
  databaseUrl: 'postgres://team',
  ownerUserId: 'u1',
  teamId: 'team-a',
  serverUrl: 'http://team-a:38890',
  apiKey: 'cmem_test',
  projectId: 'p1',
};

describe('runConvert', () => {
  it('copies and verifies, then reports success', async () => {
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(false) };
    const phases: string[] = [];
    const r = await runConvert(deps, baseInput, p => phases.push(p.phase));
    expect(r.status).toBe('converted');
    expect(phases).toContain('copying');
    expect(phases).toContain('verifying');
  });

  it('returns the join info the project needs, instead of applying it', async () => {
    const r = await runConvert({ copyDeps: baseCopyDeps(false) }, baseInput);
    expect(r.join).toEqual({
      teamId: 'team-a',
      projectId: 'p1',
      serverUrl: 'http://team-a:38890',
      apiKey: 'cmem_test',
    });
  });

  it('reports restartRequired false — the marker is re-read per call, verified live', async () => {
    // selectRuntime() re-reads the project marker on every call and
    // buildServerContext() takes the marker's serverUrl at highest precedence,
    // both confirmed against a running server. The old `true` described a GLOBAL
    // runtime switch (settings.json, which IS cached), not a per-project convert.
    const r = await runConvert({ copyDeps: baseCopyDeps(false) }, baseInput);
    expect(r.restartRequired).toBe(false);
  });

  it('does NOT return join info when verification fails', async () => {
    // No join means nothing can flip, so a short copy cannot leave a project
    // pointed at an incomplete remote.
    const r = await runConvert({ copyDeps: baseCopyDeps(true) }, baseInput);
    expect(r.status).toBe('verify_failed');
    expect(r.join).toBeUndefined();
    expect(r.restartRequired).toBe(false);
    expect(r.mismatches?.length).toBeGreaterThan(0);
  });

  it('carries the authenticated project through to the join info', async () => {
    // The join must describe the project that was actually copied — if these
    // could diverge, a user could convert one project and flip another.
    const r = await runConvert({ copyDeps: baseCopyDeps(false) }, {
      ...baseInput, projectId: 'p-other', teamId: 'team-other',
    });
    expect(r.join?.projectId).toBe('p-other');
    expect(r.join?.teamId).toBe('team-other');
  });

  it('reports the per-table copy counts', async () => {
    const r = await runConvert({ copyDeps: baseCopyDeps(false) }, baseInput);
    expect(r.copiedByTable?.observations).toBe(1);
  });
});
